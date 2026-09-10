import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

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
});

describe("resolveRuntimeWorkerArgv", () => {
  it("keeps installation workspace aliases when the worker cwd is a private artifact", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-worker-alias-"));
    try {
      const worker = path.join(directory, "worker.mts");
      // This actual source dependency relies on repository paths, not a package
      // installed in the task-controlled working directory.
      const dependency = new URL("../agents/agent-scope-config.ts", import.meta.url).href;
      await writeFile(
        worker,
        `await import(${JSON.stringify(dependency)}); process.stdout.write("loaded");`,
      );
      const result = await promisify(execFile)(
        process.execPath,
        resolveRuntimeWorkerArgv(pathToFileURL(worker)),
        { cwd: directory, timeout: 15_000 },
      );
      expect(result.stdout).toBe("loaded");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves import-only dependencies when a source worker loads compiled ESM", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-worker-esm-"));
    try {
      const dependency = path.join(directory, "node_modules", "import-only");
      await mkdir(dependency, { recursive: true });
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ type: "module", exports: { import: "./index.js" } }),
      );
      await writeFile(path.join(dependency, "index.js"), "export default 42;");
      await writeFile(
        path.join(directory, "compiled.js"),
        "import value from 'import-only'; export { value };",
      );
      const worker = path.join(directory, "worker.mts");
      await writeFile(
        worker,
        "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); process.stdout.write(String(require('./compiled.js').value));",
      );
      const result = await promisify(execFile)(
        process.execPath,
        resolveRuntimeWorkerArgv(pathToFileURL(worker)),
        { cwd: directory, timeout: 15_000 },
      );
      expect(result.stdout).toBe("42");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("loads a source worker outside the installation without resolving packages from its cwd", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "runtime-worker-cwd-"));
    try {
      const worker = path.join(directory, "worker.mts");
      await writeFile(worker, "const value: number = 42; process.stdout.write(String(value));");
      const result = await promisify(execFile)(
        process.execPath,
        resolveRuntimeWorkerArgv(pathToFileURL(worker)),
        { cwd: directory, timeout: 15_000 },
      );
      expect(result.stdout).toBe("42");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    { runtime: "/usr/bin/node", typescriptLoader: true },
    { runtime: "C:\\Program Files\\nodejs\\node.exe", typescriptLoader: true },
    { runtime: "/opt/homebrew/bin/bun", typescriptLoader: false },
    { runtime: "C:\\Program Files\\Bun\\bun.exe", typescriptLoader: false },
  ])("uses the source loader appropriate for $runtime", ({ runtime, typescriptLoader }) => {
    for (const extension of ["ts", "mts", "cts", "js", "mjs"]) {
      const url = pathToFileURL(path.resolve(`worker fixture.${extension}`));
      const args = resolveRuntimeWorkerArgv(url, runtime);
      expect(args.at(-1)).toBe(fileURLToPath(url));
      if (!typescriptLoader || !extension.endsWith("ts")) {
        expect(args).toEqual([fileURLToPath(url)]);
      } else {
        expect(args).toHaveLength(3);
        expect(args[0]).toBe("--import");
        if (extension === "cts") {
          expect(args[1]).toBe(import.meta.resolve("tsx"));
        } else {
          expect(args[1]).toMatch(/^data:text\/javascript;base64,/);
        }
      }
    }
  });
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
