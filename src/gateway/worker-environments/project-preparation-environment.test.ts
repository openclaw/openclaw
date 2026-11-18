import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";

const operations: Array<{ close(): void }> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    operations.splice(0).forEach((operation) => operation.close());
    cleanup();
  }),
);
const shell = (command: string) => ["sh", "-c", command];
const readText = (root: string, ...parts: string[]) =>
  fs.readFile(path.join(root, ...parts), "utf8");
async function expectFiles(root: string, files: Record<string, string>) {
  expect(await Promise.all(Object.keys(files).map((file) => readText(root, file)))).toEqual(
    Object.values(files),
  );
}

async function fixture(files: Record<string, string>) {
  const f = await createProjectPreparationFixture(
    tempDirs.make("project-preparation-environment-"),
    undefined,
    false,
    { ".gitignore": "build/\n", ...files },
  );
  const bin = path.join(f.home, "fixture-bin");
  await fs.mkdir(bin);
  const nodeExecutable = resolveTestNodeExecPath();
  // Linux selects tools beside process.execPath; a symlink to host Node would select host tools.
  // A separate copier keeps writable Node descriptors out of sibling Vitest forks.
  execFileSync(nodeExecutable, [
    "-e",
    'const fs = require("node:fs"); fs.copyFileSync(process.execPath, process.argv[1], fs.constants.COPYFILE_FICLONE)',
    path.join(bin, "node"),
  ]);
  const libraries = path.resolve(path.dirname(nodeExecutable), "../lib");
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
    await writeCommand(command, "exit 254");
  }
  function writeCommand(command: string, body: string) {
    return fs.writeFile(path.join(bin, command), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
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
  return {
    ...f,
    writeCommand,
    preparedOperation: async (...args: Parameters<typeof f.preparedOperation>) => {
      const operation = await f.preparedOperation(...args);
      operations.push(operation);
      return operation;
    },
  };
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
            environment: shell(
              'set -eu; test "$MODE" = build; test "$SHARED" = remote; test -z "${PREPARATION_UNRELATED_ENV:-}"; mkdir -p build; printf ready > build/environment',
            ),
          },
          updateContentCommand: shell(
            "set -eu; test -f build/cached; test -f build/environment; cat input.txt > build/current; printf 'updateContent\\n' >> build/order",
          ),
          postCreateCommand: "printf 'postCreate\\n' >> build/order",
          postStartCommand: "printf 'postStart\\n' >> build/order",
        }),
    });
    const first = await f.preparedOperation();
    const result = await first.project.prepare(f);
    expect(result).toMatchObject({
      captureRequired: true,
      recipePreparation: {
        source: "devcontainer",
        ignoredPropertiesNote: "devcontainer image ignored on cloud machines",
        phaseDurationsMs: { onCreate: expect.any(Number), updateContent: expect.any(Number) },
      },
    });
    const prepared = result.preparedWorkspace!;
    first.close();
    await fs.writeFile(path.join(f.repository, "input.txt"), "updated content\n");
    await requireGit(f.repository, ["add", "input.txt"]);
    await requireGit(f.repository, ["commit", "--quiet", "-m", "refresh content"]);
    const refreshedProject = (await prepareWorkerProjectSnapshot({
      localPath: f.repository,
      namespace: "gateway",
    }))!;
    const refreshed = await f.preparedOperation(() => {}, { project: refreshedProject });
    const refreshedResult = await refreshed.project.prepare(f);
    expect(refreshedResult).toMatchObject({
      captureRequired: true,
      preparedWorkspace: { cacheKey: prepared.cacheKey },
    });
    expect(refreshedResult.recipePreparation!.phaseDurationsMs).toMatchObject({
      updateContent: expect.any(Number),
    });
    await expectFiles(prepared.workspaceDir, {
      "build/order": "onCreate\nupdateContent\nupdateContent\n",
      "build/cached": "prepared base\n",
      "build/current": "updated content\n",
      "created.txt": "initialized",
    });
    expect(await requireGit(prepared.workspaceDir, ["rev-parse", "HEAD"])).toBe(
      refreshedProject.baseCommit,
    );
  });

  it("projects worker initializer credentials for each preparation command without returning or reusing them", async () => {
    const check =
      'set -eu; test "$FEED_TOKEN" = synthetic-feed; test -z "${PREPARATION_UNRELATED_ENV:-}"; mkdir -p build; printf ready > build/initialized';
    const f = await fixture({
      ".devcontainer.json": JSON.stringify({
        containerEnv: { FEED_TOKEN: "repository-value" },
        onCreateCommand: { first: check, second: check },
        updateContentCommand: check,
      }),
    });
    const helper = path.join(f.home, "trusted-initializer.cjs");
    const calls = path.join(f.home, "initializer.calls");
    await fs.writeFile(
      helper,
      `
const fs = require("node:fs");
if (process.env.PREPARATION_UNRELATED_ENV !== "must-not-forward") process.exit(2);
const input = JSON.parse(fs.readFileSync(0, "utf8"));
if (!(input.timeoutMs > 0 && input.timeoutMs <= 30000)) process.exit(3);
fs.appendFileSync(${JSON.stringify(calls)}, "called\\n");
process.stdout.write(JSON.stringify({ FEED_TOKEN: "synthetic-feed" }));
`,
    );
    const transport = {
      ...f,
      setupInitializer: { command: [process.execPath, helper], envKeys: ["FEED_TOKEN"] },
    };
    const first = await f.preparedOperation();
    try {
      const result = await first.project.prepare(transport);
      expect(result.recipePreparation!.failure).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("synthetic-feed");
      expect(await fs.readFile(calls, "utf8")).toBe("called\n".repeat(3));
    } finally {
      first.close();
    }
    const reused = await f.preparedOperation();
    try {
      const result = await reused.project.prepare(transport);
      expect(result.captureRequired).toBeUndefined();
      expect(await fs.readFile(calls, "utf8")).toBe("called\n".repeat(3));
    } finally {
      reused.close();
    }
  });

  it.each(["recipe", "unmarked", "initializer", "invalid-environment"] as const)(
    "saves safe failure diagnostics with initializer credentials (%s)",
    async (failure) => {
      const f = await fixture({
        ".devcontainer.json": JSON.stringify({
          onCreateCommand: [
            "sh",
            "-c",
            failure === "unmarked"
              ? "printf 'private-feed-token' >&2; exit 7"
              : "printf 'private-feed-token\\n' >&2; printf 'TEAMCLAW_SETUP_V1 stage=setup_contract outcome=failed exit=7 reason=setup_inputs_unsupported\\n' >&2; printf 'TEAMCLAW_SETUP_V1 stage=secret_token outcome=failed exit=7\\n' >&2; exit 7",
          ],
        }),
      });
      const logFile = path.join(f.home, "safe-setup.log");
      setLoggerOverride({ level: "error", consoleLevel: "silent", file: logFile });
      const helper = path.join(f.home, "trusted-initializer.cjs");
      await fs.writeFile(
        helper,
        `process.stderr.write("private-identity-header\\nTEAMCLAW_SETUP_V1 stage=credential_transport outcome=${failure === "initializer" ? "failed exit=3" : "succeeded"} elapsedMs=2\\n"); process.stdout.write(${JSON.stringify(failure === "invalid-environment" ? '{"FEED_TOKEN":"private-feed-token","unexpected":"private-value"}' : '{"FEED_TOKEN":"private-feed-token"}')}); ${failure === "initializer" ? "process.exitCode=3;" : ""}`,
      );
      if (failure === "unmarked") {
        await fs.writeFile(
          helper,
          'process.stderr.write("private-identity-header"); process.stdout.write(JSON.stringify({FEED_TOKEN:"private-feed-token"}));',
        );
      }
      const recordRecipePreparation = vi.fn();
      const operation = await f.preparedOperation();
      try {
        await expect(
          operation.project.prepare({
            ...f,
            setupInitializer: { command: [process.execPath, helper], envKeys: ["FEED_TOKEN"] },
            recordRecipePreparation,
          }),
        ).rejects.toThrow(/Prepared project (setup|initializer)/);
        expect(recordRecipePreparation).toHaveBeenCalledOnce();
        const metadata = recordRecipePreparation.mock.calls[0]![0];
        const saved = JSON.parse(metadata.failure.outputTail);
        expect(saved.schema).toBe("openclaw.setup-diagnostics.v1");
        expect(saved.events).toContainEqual(
          expect.objectContaining({
            origin: "native",
            stage: failure === "recipe" || failure === "unmarked" ? "onCreate" : "initializer",
            outcome: "failed",
            reason: failure === "invalid-environment" ? "invalid_environment" : "nonzero_exit",
            elapsedMs: expect.any(Number),
          }),
        );
        if (failure !== "unmarked") {
          expect(saved.events).toContainEqual(
            expect.objectContaining({
              origin: "initializer",
              stage: "credential_transport",
              outcome: failure === "initializer" ? "failed" : "succeeded",
              elapsedMs: 2,
            }),
          );
        }
        if (failure === "recipe") {
          expect(saved.events).toContainEqual(
            expect.objectContaining({
              origin: "repository",
              stage: "setup_contract",
              outcome: "failed",
              exit: 7,
              reason: "setup_inputs_unsupported",
            }),
          );
        }
        await flushLogger();
        const logged = await fs.readFile(logFile, "utf8");
        expect(logged).toContain("Worker project setup failed");
        expect(logged).toContain(
          failure === "invalid-environment" ? "invalid_environment" : "nonzero_exit",
        );
        expect(logged).not.toMatch(
          /private-feed-token|private-identity-header|private-value|secret_token/,
        );
        if (failure === "unmarked") {
          expect(saved.events).toHaveLength(1);
        }
        expect(JSON.stringify(metadata)).not.toMatch(
          /private-feed-token|private-identity-header|private-value|secret_token/,
        );
      } finally {
        await flushLogger();
        setLoggerOverride(null);
        operation.close();
      }
    },
  );

  it.each(["pnpm-lock.yaml", "yarn.lock"])(
    "installs through user-writable Corepack shims without auto-pinning or download prompts during %s detection",
    async (lockfile) => {
      const packageContent = '{"name":"fixture","private":true}\n';
      const f = await fixture({ [lockfile]: "fixture lock\n", "package.json": packageContent });
      const manager = lockfile === "yarn.lock" ? "yarn" : "pnpm";
      await f.writeCommand(
        "corepack",
        'set -eu\ntest "$1" = enable\ntest "$2" = --install-directory\ntest "$3" = "$HOME/.local/bin"\n' +
          `node -e 'const fs = require("node:fs"); const path = require("node:path"); fs.copyFileSync(path.join(path.dirname(fs.realpathSync(process.argv[1])), "package-manager"), path.join(process.argv[2], "${manager}"))' "$0" "$3"\n`,
      );
      await f.writeCommand(manager, "exit 1");
      await f.writeCommand(
        "package-manager",
        'set -eu\ntest "${COREPACK_ENABLE_DOWNLOAD_PROMPT:-}" = 0\nif [ "${COREPACK_ENABLE_AUTO_PIN:-}" != 0 ]; then printf \'{"packageManager":"fixture"}\\n\' > package.json; fi',
      );
      const operation = await f.preparedOperation();
      const result = await operation.project.prepare(f);
      expect(result.captureRequired).toBe(true);
      expect(result.recipePreparation!.failure).toBeUndefined();
      expect(await readText(result.preparedWorkspace!.workspaceDir, "package.json")).toBe(
        packageContent,
      );
    },
  );

  it.each(["UTF-8", "invalid UTF-8"])(
    "continues cold with bounded diagnostics when a detected install fails (%s)",
    async (encoding) => {
      const f = await fixture({ "package-lock.json": "{}\n" });
      await f.writeCommand(
        "npm",
        `exec node -e 'process.stderr.write(${encoding === "UTF-8" ? '"é".repeat(20000)' : "Buffer.alloc(20000, 255)"}); process.exit(23)'`,
      );
      const recordRecipePreparation = vi.fn();
      const operation = await f.preparedOperation();
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
      expect(outputTail.includes("�")).toBe(encoding !== "UTF-8");
      expect(recordRecipePreparation).toHaveBeenCalledWith(result.recipePreparation);
      const prepared = result.preparedWorkspace!;
      expect(await readText(prepared.workspaceDir, "input.txt")).toBe("prepared base\n");
    },
  );

  it("fails declared parallel setup visibly after all branches settle and records the reason", async () => {
    const f = await fixture({
      ".devcontainer.json": JSON.stringify({
        onCreateCommand: {
          failed: "printf declared-error >&2; exit 7",
          complete: shell("mkdir -p build; printf finished > build/sibling"),
        },
        updateContentCommand: "printf unexpected > build/update",
      }),
    });
    const recordRecipePreparation = vi.fn();
    const operation = await f.preparedOperation();
    await expect(operation.project.prepare({ ...f, recordRecipePreparation })).rejects.toThrow(
      "Prepared project setup failed: exit 7: declared-error",
    );
    expect(recordRecipePreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "devcontainer",
        phaseDurationsMs: expect.objectContaining({ onCreate: expect.any(Number) }),
        failure: { reason: "Prepared project setup failed: exit 7", outputTail: "declared-error" },
      }),
    );
    const workspace = path.join(
      f.home,
      ".openclaw-worker",
      "prepared",
      "gateway",
      "c".repeat(64),
      "workspace",
    );
    expect(await readText(workspace, "build", "sibling")).toBe("finished");
    expect(
      await fs.stat(path.join(workspace, "build", "update")).catch(() => undefined),
    ).toBeUndefined();
    expect(operation.getPreparedWorkspace()).toBeUndefined();
  });
});
