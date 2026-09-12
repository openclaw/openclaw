import { execFile } from "node:child_process";
import { link, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const requireFromHere = createRequire(import.meta.url);

describe("resolveRuntimeWorkerUrl", () => {
  it("resolves source siblings and stable packaged worker paths", () => {
    const root = path.resolve("worker-fixture-root");
    expect(
      fileURLToPath(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: pathToFileURL(path.join(root, "src/agents/code-mode-worker.ts")).href,
          sourceWorkerName: "code-mode.worker",
          distWorkerPath: "agents/code-mode.worker.js",
        }),
      ),
    ).toBe(path.join(root, "src/agents/code-mode.worker.ts"));

    for (const currentModuleUrl of [
      pathToFileURL(path.join(root, "dist/agents/code-mode.js")).href,
      pathToFileURL(path.join(root, "dist/selection-abc123.js")).href,
      pathToFileURL(path.join(root, "dist/selection-abc123.mjs")).href,
    ]) {
      expect(
        fileURLToPath(
          resolveRuntimeWorkerUrl({
            currentModuleUrl,
            sourceWorkerName: "code-mode.worker",
            distWorkerPath: "agents/code-mode.worker.js",
          }),
        ),
      ).toBe(path.join(root, "dist/agents/code-mode.worker.js"));
      const candidateRoot = path.join(root, "candidate");
      expect(
        fileURLToPath(
          resolveRuntimeWorkerUrl({
            currentModuleUrl,
            sourceWorkerName: "code-mode.worker",
            distWorkerPath: "agents/code-mode.worker.js",
            root: candidateRoot,
          }),
        ),
      ).toBe(path.join(candidateRoot, "dist/agents/code-mode.worker.js"));
    }
  });

  it("selects plugin package paths with hardlinked manifests, renamed directories, and chunks", async () => {
    await withTempDir("openclaw-renamed-worker-package-", async (root) => {
      const entry = {
        sourceWorkerName: "store.worker",
        distWorkerPath: "extensions/store/store.worker.js",
        package: { name: "@openclaw/store", distWorkerPath: "src/store.worker.js" },
      };
      await writeFile(path.join(root, "package-store.json"), "{}");
      await link(path.join(root, "package-store.json"), path.join(root, "package.json"));
      for (const packageName of ["openclaw", "@openclaw/store"]) {
        await writeFile(path.join(root, "package.json"), JSON.stringify({ name: packageName }));
        for (const modulePath of ["dist/index.js", "dist/.setup/shared-abc.mjs"]) {
          const currentModuleUrl = pathToFileURL(path.join(root, modulePath)).href;
          expect(fileURLToPath(resolveRuntimeWorkerUrl({ ...entry, currentModuleUrl }))).toBe(
            path.join(
              root,
              "dist",
              packageName === entry.package.name
                ? entry.package.distWorkerPath
                : entry.distWorkerPath,
            ),
          );
          expect(fileURLToPath(resolveRuntimeWorkerUrl({ ...entry, currentModuleUrl, root }))).toBe(
            path.join(root, "dist", entry.distWorkerPath),
          );
        }
      }
      await writeFile(path.join(root, "package.json"), "invalid-json");
      expect(() =>
        resolveRuntimeWorkerUrl({
          ...entry,
          currentModuleUrl: pathToFileURL(path.join(root, "dist/index.js")).href,
        }),
      ).toThrow("Cannot resolve runtime worker package");
      expect(
        fileURLToPath(
          resolveRuntimeWorkerUrl({
            ...entry,
            currentModuleUrl: pathToFileURL(path.join(root, "src/entry.ts")).href,
          }),
        ),
      ).toBe(path.join(root, "src/store.worker.ts"));
    });
  });
});

describe("resolveRuntimeWorkerArgv", () => {
  it.each([
    { runtime: "/usr/bin/node", typescriptLoader: true },
    { runtime: "C:\\Program Files\\nodejs\\node.exe", typescriptLoader: true },
    { runtime: "/opt/homebrew/bin/bun", typescriptLoader: false },
    { runtime: "C:\\Program Files\\Bun\\bun.exe", typescriptLoader: false },
  ])("uses the source loader appropriate for $runtime", ({ runtime, typescriptLoader }) => {
    for (const extension of ["ts", "mts", "cts", "js", "mjs"]) {
      const url = pathToFileURL(path.resolve(`worker fixture.${extension}`));
      const tsxUrl = pathToFileURL(requireFromHere.resolve("tsx")).href;
      const loader = typescriptLoader && extension.endsWith("ts") ? ["--import", tsxUrl] : [];
      expect(resolveRuntimeWorkerArgv(url, runtime)).toEqual([...loader, fileURLToPath(url)]);
    }
  });

  it.each(["ts", "mts", "cts"])(
    "runs a .%s worker from outside the package directory",
    async (extension) => {
      await withTempDir("openclaw-worker-cwd-", async (cwd) => {
        const entry = path.join(cwd, `worker fixture.${extension}`);
        await writeFile(entry, "enum Answer { value = 42 }; console.log(Answer.value);");
        const { stdout } = await promisify(execFile)(
          process.execPath,
          resolveRuntimeWorkerArgv(pathToFileURL(entry)),
          { cwd, timeout: 10_000 },
        );
        expect(stdout.trim()).toBe("42");
      });
    },
  );
});

describe("resolveRuntimeProcessEntrypointUrl", () => {
  it("uses canonical launchers unless the sealed bundle registers a sibling", async () => {
    vi.resetModules();
    try {
      const { registerSealedRuntimeProcessEntrypoint, resolveRuntimeProcessEntrypointUrl } =
        await import("./runtime-process-url.js");
      const { runtimeProcessEntrypoints } = await import("./runtime-process-entrypoints.js");
      expect(resolveRuntimeProcessEntrypointUrl("githubExec")).toEqual(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.githubExec),
      );
      const sqliteUrl = resolveRuntimeProcessEntrypointUrl("sqliteReadOnly");
      const sealedUrl = new URL("file:///worker-bundle/github-exec-launcher.mjs");
      registerSealedRuntimeProcessEntrypoint("githubExec", sealedUrl);
      expect(resolveRuntimeProcessEntrypointUrl("githubExec")).toEqual(sealedUrl);
      expect(resolveRuntimeProcessEntrypointUrl("sqliteReadOnly")).toEqual(sqliteUrl);
    } finally {
      vi.resetModules();
    }
  });
});
