import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTreeCloseOnExec } from "../../../test/helpers/close-on-exec-copy.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import { readWorkerProjectEnvironmentRecipe } from "./project-preparation.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(files: Record<string, string>) {
  const f = await createProjectPreparationFixture(
    tempDirs.make("project-preparation-environment-"),
    undefined,
    false,
    { ".gitignore": "build/\n", ...files },
  );
  const bin = path.join(f.home, "fixture-bin");
  await fs.mkdir(bin);
  // Linux selects tools beside process.execPath; a symlink to host Node would select host tools.
  copyTreeCloseOnExec(process.execPath, path.join(bin, "node"), { dereference: true });
  const libraries = path.resolve(path.dirname(process.execPath), "../lib");
  if (existsSync(libraries)) {
    await fs.symlink(libraries, path.join(f.home, "lib"));
  }
  for (const command of ["sh", "git", "uname", "mkdir", "cat"]) {
    const executable = resolveExecutablePath(command);
    if (!executable) {
      throw new Error(`Project preparation fixture requires ${command}`);
    }
    await fs.symlink(executable, path.join(bin, command));
  }
  for (const command of ["npm", "npx", "corepack", "pnpm", "yarn"]) {
    await fs.writeFile(path.join(bin, command), "#!/bin/sh\nexit 254\n", { mode: 0o755 });
  }
  f.runScript.mockImplementation(async (script) =>
    execFileSync(path.join(bin, "sh"), ["-c", script], {
      env: {
        PATH: bin,
        HOME: f.home,
        LANG: "C.UTF-8",
        PREPARATION_UNRELATED_ENV: "must-not-forward",
      },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  return { ...f, bin };
}

describe("repository environment preparation", () => {
  it("bakes create then content phases into the workspace and refreshes only content", async () => {
    const f = await fixture({
      ".devcontainer/devcontainer.json":
        "// Lifecycle commands run on the host, with the declared environment.\n" +
        JSON.stringify({
          image: "node:test",
          containerEnv: { MODE: "build", SHARED: "container" },
          remoteEnv: { SHARED: "remote" },
          onCreateCommand: {
            cache:
              "mkdir -p build; test ! -f build/cached; cat input.txt > build/cached; printf 'onCreate\\n' > build/order; printf initialized > created.txt",
            environment: [
              "sh",
              "-c",
              'set -eu; test "$MODE" = build; test "$SHARED" = remote; test -z "${PREPARATION_UNRELATED_ENV:-}"; mkdir -p build; printf ready > build/environment',
            ],
          },
          updateContentCommand: [
            "sh",
            "-c",
            "set -eu; test -f build/cached; test -f build/environment; cat input.txt > build/current; printf 'updateContent\\n' >> build/order",
          ],
          postCreateCommand: "printf 'postCreate\\n' >> build/order",
          postStartCommand: "printf 'postStart\\n' >> build/order",
        }),
    });
    const recipe = await readWorkerProjectEnvironmentRecipe(f.project);
    const first = await f.preparedOperation();
    let prepared;
    try {
      const result = await first.project.prepare(f);
      expect(result.captureRequired).toBe(true);
      expect(result.recipePreparation).toMatchObject({
        source: "devcontainer",
        ignoredPropertiesNote: "devcontainer image ignored on cloud machines",
        phaseDurationsMs: { onCreate: expect.any(Number), updateContent: expect.any(Number) },
      });
      prepared = result.preparedWorkspace!;
      expect(await fs.readFile(path.join(prepared.workspaceDir, "build", "order"), "utf8")).toBe(
        "onCreate\nupdateContent\n",
      );
      expect(await fs.readFile(path.join(prepared.workspaceDir, "build", "cached"), "utf8")).toBe(
        "prepared base\n",
      );
      expect(await fs.readFile(path.join(prepared.workspaceDir, "created.txt"), "utf8")).toBe(
        "initialized",
      );
    } finally {
      first.close();
    }
    await fs.writeFile(path.join(f.repository, "input.txt"), "updated content\n");
    await requireGit(f.repository, ["add", "input.txt"]);
    await requireGit(f.repository, ["commit", "--quiet", "-m", "refresh content"]);
    const refreshedProject = (await prepareWorkerProjectSnapshot({
      localPath: f.repository,
      namespace: "gateway",
    }))!;
    expect((await readWorkerProjectEnvironmentRecipe(refreshedProject)).identity).toBe(
      recipe.identity,
    );
    const refreshed = await f.preparedOperation(() => {}, { project: refreshedProject });
    try {
      const result = await refreshed.project.prepare(f);
      expect(result.captureRequired).toBe(true);
      expect(result.preparedWorkspace!.cacheKey).toBe(prepared.cacheKey);
      expect(result.recipePreparation!.phaseDurationsMs).toEqual({
        updateContent: expect.any(Number),
      });
      expect(await fs.readFile(path.join(prepared.workspaceDir, "build", "order"), "utf8")).toBe(
        "onCreate\nupdateContent\nupdateContent\n",
      );
      expect(await fs.readFile(path.join(prepared.workspaceDir, "build", "cached"), "utf8")).toBe(
        "prepared base\n",
      );
      expect(await fs.readFile(path.join(prepared.workspaceDir, "build", "current"), "utf8")).toBe(
        "updated content\n",
      );
      expect(await fs.readFile(path.join(prepared.workspaceDir, "created.txt"), "utf8")).toBe(
        "initialized",
      );
      expect(await requireGit(prepared.workspaceDir, ["rev-parse", "HEAD"])).toBe(
        refreshedProject.baseCommit,
      );
    } finally {
      refreshed.close();
    }
  });

  it.each(["pnpm-lock.yaml", "yarn.lock"])(
    "installs through user-writable Corepack shims without auto-pinning during %s detection",
    async (lockfile) => {
      const packageContent = '{"name":"fixture","private":true}\n';
      const f = await fixture({ [lockfile]: "fixture lock\n", "package.json": packageContent });
      const { bin } = f;
      const manager = lockfile === "yarn.lock" ? "yarn" : "pnpm";
      await fs.writeFile(
        path.join(bin, "corepack"),
        '#!/bin/sh\nset -eu\ntest "$1" = enable\ntest "$2" = --install-directory\ntest "$3" = "$HOME/.local/bin"\n' +
          `node -e 'const fs = require("node:fs"); const path = require("node:path"); fs.copyFileSync(path.join(path.dirname(fs.realpathSync(process.argv[1])), "package-manager"), path.join(process.argv[2], "${manager}"))' "$0" "$3"\n`,
        { mode: 0o755 },
      );
      await fs.writeFile(path.join(bin, manager), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      await fs.writeFile(
        path.join(bin, "package-manager"),
        '#!/bin/sh\nif [ "${COREPACK_ENABLE_AUTO_PIN:-}" != 0 ]; then printf \'{"packageManager":"fixture"}\\n\' > package.json; fi\n',
        { mode: 0o755 },
      );
      const operation = await f.preparedOperation();
      try {
        const result = await operation.project.prepare(f);
        expect(result.captureRequired).toBe(true);
        expect(result.recipePreparation!.failure).toBeUndefined();
        expect(
          await fs.readFile(
            path.join(result.preparedWorkspace!.workspaceDir, "package.json"),
            "utf8",
          ),
        ).toBe(packageContent);
      } finally {
        operation.close();
      }
    },
  );

  it.each(["UTF-8", "invalid UTF-8"])(
    "continues cold with bounded diagnostics when a detected install fails (%s)",
    async (encoding) => {
      const f = await fixture({ "package-lock.json": "{}\n" });
      const { bin } = f;
      await fs.writeFile(
        path.join(bin, "npm"),
        `#!/bin/sh\nexec node -e 'process.stderr.write(${encoding === "UTF-8" ? '"é".repeat(20000)' : "Buffer.alloc(20000, 255)"}); process.exit(23)'\n`,
        { mode: 0o755 },
      );
      const recordRecipePreparation = vi.fn();
      const operation = await f.preparedOperation();
      try {
        const result = await operation.project.prepare({ ...f, recordRecipePreparation });
        expect(result.captureRequired).toBeUndefined();
        expect(result.captureSkipped).toBe(
          "Detected dependency installation failed; starting without a snapshot",
        );
        expect(result.recipePreparation).toMatchObject({
          source: "detected",
          phaseDurationsMs: { detectedInstall: expect.any(Number) },
          failure: { reason: "Prepared project setup failed: exit 23" },
        });
        const outputTail = result.recipePreparation!.failure!.outputTail!;
        expect(Buffer.byteLength(outputTail)).toBeGreaterThan(16_000);
        expect(Buffer.byteLength(outputTail)).toBeLessThanOrEqual(16_384);
        if (encoding === "UTF-8") {
          expect(outputTail).not.toContain("�");
        } else {
          expect(outputTail).toContain("�");
        }
        expect(recordRecipePreparation).toHaveBeenCalledWith(result.recipePreparation);
        const prepared = result.preparedWorkspace!;
        expect(operation.getPreparedWorkspace()).toEqual(prepared);
        expect(await fs.readFile(path.join(prepared.workspaceDir, "input.txt"), "utf8")).toBe(
          "prepared base\n",
        );
      } finally {
        operation.close();
      }
    },
  );

  it("fails declared parallel setup visibly after all branches settle and records the reason", async () => {
    const f = await fixture({
      ".devcontainer.json": JSON.stringify({
        onCreateCommand: {
          failed: "printf declared-error >&2; exit 7",
          complete: ["sh", "-c", "mkdir -p build; printf finished > build/sibling"],
        },
        updateContentCommand: "printf unexpected > build/update",
      }),
    });
    const recordRecipePreparation = vi.fn();
    const operation = await f.preparedOperation();
    try {
      await expect(operation.project.prepare({ ...f, recordRecipePreparation })).rejects.toThrow(
        "Prepared project setup failed: exit 7: declared-error",
      );
      expect(recordRecipePreparation).toHaveBeenCalledWith({
        source: "devcontainer",
        phaseDurationsMs: { onCreate: expect.any(Number) },
        failure: { reason: "Prepared project setup failed: exit 7", outputTail: "declared-error" },
      });
      const workspace = path.join(
        f.home,
        ".openclaw-worker",
        "prepared",
        "gateway",
        "c".repeat(64),
        "workspace",
      );
      expect(await fs.readFile(path.join(workspace, "build", "sibling"), "utf8")).toBe("finished");
      expect(
        await fs.stat(path.join(workspace, "build", "update")).catch(() => undefined),
      ).toBeUndefined();
      expect(operation.getPreparedWorkspace()).toBeUndefined();
    } finally {
      operation.close();
    }
  });
});
