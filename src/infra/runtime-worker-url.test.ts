import { execFile } from "node:child_process";
import { link, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
  runtimeNeedsTypeScriptLoader,
} from "./runtime-worker-url.js";

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
    const originalArgs = process.execArgv;
    const compilerArgs = [
      "--no-maglev",
      "--no_maglev",
      "--maglev",
      "--concurrent-sparkplug",
      "--concurrent_sparkplug",
      "--no-concurrent-sparkplug",
      "--no_concurrent_sparkplug",
    ];
    process.execArgv = [
      "--import",
      "file:///parent-loader.mjs",
      ...compilerArgs,
      "--eval",
      "void 0",
      "--inspect=127.0.0.1:9229",
      "--title=--no-maglev",
    ];
    try {
      for (const extension of ["ts", "mts", "cts", "js", "mjs"]) {
        const url = pathToFileURL(path.resolve(`worker fixture.${extension}`));
        const tsxUrl = pathToFileURL(requireFromHere.resolve("tsx")).href;
        const loader = typescriptLoader && extension.endsWith("ts") ? ["--import", tsxUrl] : [];
        expect(resolveRuntimeWorkerArgv(url, runtime)).toEqual([
          ...(typescriptLoader ? [...compilerArgs, ...loader] : ["--no-install"]),
          fileURLToPath(url),
        ]);
        expect(resolveRuntimeWorkerThreadExecArgv(url, runtime)).toEqual(
          typescriptLoader && extension.endsWith("ts")
            ? ["--import", import.meta.resolve("tsx/esm")]
            : [],
        );
      }
    } finally {
      process.execArgv = originalArgs;
    }
  });

  it.each([
    { runtime: "Bun", bun: "fixture", executable: "custom-runtime" },
    { runtime: "Node", bun: undefined, executable: "bun" },
  ])("uses current $runtime metadata without changing foreign runtimes", ({ bun, executable }) => {
    const descriptors = Object.getOwnPropertyDescriptors(process);
    const currentExecutable = path.resolve("current-runtime-fixture", executable);
    try {
      Object.defineProperties(process, {
        execPath: { configurable: true, value: currentExecutable },
        execArgv: { configurable: true, value: ["--no-concurrent-sparkplug"] },
        versions: { configurable: true, value: { ...process.versions, bun } },
      });
      for (const extension of ["ts", "mts", "cts", "js", "mjs"]) {
        const url = pathToFileURL(path.resolve(`worker fixture.${extension}`));
        for (const { selected, typescriptLoader } of [
          { selected: undefined, typescriptLoader: !bun },
          { selected: currentExecutable, typescriptLoader: !bun },
          { selected: path.resolve("foreign-runtime-fixture", "node"), typescriptLoader: true },
          { selected: path.resolve("foreign-runtime-fixture", "bun"), typescriptLoader: false },
        ]) {
          const needsLoader = typescriptLoader && extension.endsWith("ts");
          expect(resolveRuntimeWorkerArgv(url, selected)).toEqual([
            ...(typescriptLoader ? ["--no-concurrent-sparkplug"] : ["--no-install"]),
            ...(needsLoader ? ["--import", import.meta.resolve("tsx")] : []),
            fileURLToPath(url),
          ]);
          expect(resolveRuntimeWorkerThreadExecArgv(url, selected)).toEqual(
            needsLoader ? ["--import", import.meta.resolve("tsx/esm")] : [],
          );
          expect(runtimeNeedsTypeScriptLoader(fileURLToPath(url), selected)).toBe(needsLoader);
        }
      }
    } finally {
      Object.defineProperties(process, {
        execPath: descriptors.execPath,
        execArgv: descriptors.execArgv,
        versions: descriptors.versions,
      });
    }
  });

  it("does not preload a file loader for non-file Worker URLs", () => {
    expect(
      resolveRuntimeWorkerThreadExecArgv(new URL("data:text/javascript,postMessage(1)")),
    ).toEqual([]);
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
