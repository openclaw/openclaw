import { execFile } from "node:child_process";
import { copyFile, link, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
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

describe("runtime bootstrap entrypoint URLs", () => {
  it.each([false, true])("resolves package-owned entries (bundled=%s)", async (bundled) => {
    await withTempDir("openclaw-bootstrap-urls-", async (root) => {
      const bootstrap = path.join(root, "runtime-process-bootstrap.generated.mjs");
      await copyFile(
        new URL("../../runtime-process-bootstrap.generated.mjs", import.meta.url),
        bootstrap,
      );
      let entry = bootstrap;
      if (bundled) {
        entry = path.join(root, "dist", "chunks", "bootstrap.mjs");
        await build({
          entryPoints: [bootstrap],
          outfile: entry,
          bundle: true,
          format: "esm",
          platform: "node",
        });
      }
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        `const { resolveRuntimeBootstrapExternalEntrypointUrl, resolveRuntimeBootstrapToolingEntrypointUrl } = await import(${JSON.stringify(pathToFileURL(entry).href)});
console.log(JSON.stringify({ external: resolveRuntimeBootstrapExternalEntrypointUrl("cliLauncher").href, tooling: resolveRuntimeBootstrapToolingEntrypointUrl("kyselyTypes").href }));`,
      ]);
      expect(JSON.parse(stdout)).toEqual({
        external: pathToFileURL(path.join(root, "openclaw.mjs")).href,
        tooling: pathToFileURL(path.join(root, "scripts/generate-kysely-types.mts")).href,
      });
    });
  });
});

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

    expect(
      fileURLToPath(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: pathToFileURL(path.join(root, "src/agents/code-mode-worker.ts")).href,
          sourceWorkerName: "generated.worker",
          sourceExtension: ".mjs",
          distWorkerPath: "agents/generated.worker.js",
        }),
      ),
    ).toBe(path.join(root, "src/agents/generated.worker.mjs"));

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
      expect(resolveRuntimeWorkerArgv(url, runtime)).toEqual([
        ...(typescriptLoader ? loader : ["--no-install"]),
        fileURLToPath(url),
      ]);
      expect(resolveRuntimeWorkerThreadExecArgv(url, runtime)).toEqual(
        typescriptLoader && extension.endsWith("ts")
          ? ["--import", import.meta.resolve("tsx/esm")]
          : [],
      );
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
            ...(typescriptLoader ? [] : ["--no-install"]),
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
  it("registers only the sibling entries owned by the selected sealed bootstrap", async () => {
    vi.resetModules();
    try {
      const { registerSealedRuntimeProcessEntrypoints, resolveRuntimeProcessEntrypointUrl } =
        await import("./runtime-process-url.js");
      const originalGithub = resolveRuntimeProcessEntrypointUrl("githubExec");
      registerSealedRuntimeProcessEntrypoints(
        "serviceChildRelay",
        "file:///relay/service-child-relay.mjs",
      );
      const anchor = new URL("file:///relay/service-child-group-anchor.mjs");
      expect(resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor")).toEqual(anchor);
      expect(resolveRuntimeProcessEntrypointUrl("githubExec")).toEqual(originalGithub);
      registerSealedRuntimeProcessEntrypoints("worker", "file:///worker/worker.mjs");
      expect(resolveRuntimeProcessEntrypointUrl("githubExec")).toEqual(
        new URL("file:///worker/github-exec-launcher.mjs"),
      );
      expect(resolveRuntimeProcessEntrypointUrl("sharedStateStore")).toEqual(
        resolveRuntimeProcessEntrypointUrl("sqliteStore"),
      );
      expect(resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor")).toEqual(anchor);
    } finally {
      vi.resetModules();
    }
  });
});

describe("resolveExternalPackageRuntimeEntrypointUrl", () => {
  it.each([
    ["sourceCli", "src/entry.ts"],
    ["cliLauncher", "openclaw.mjs"],
    ["preinstall", "scripts/preinstall-package-manager-warning.mjs"],
    ["postinstall", "scripts/postinstall-bundled-plugins.mjs"],
  ] as const)("resolves %s in the selected package", async (name, relativePath) => {
    const { resolveExternalPackageRuntimeEntrypointUrl } = await import("./runtime-process-url.js");
    const packageRoot = path.resolve("external package with spaces");
    expect(resolveExternalPackageRuntimeEntrypointUrl(name, packageRoot)).toEqual(
      pathToFileURL(path.join(packageRoot, relativePath)),
    );
  });
});

describe("resolveRuntimeScriptEntrypointUrl", () => {
  it("resolves the declared handoff script in its staging directory", async () => {
    const { resolveRuntimeScriptEntrypointUrl } = await import("./runtime-process-url.js");
    const directory = path.resolve("handoff directory #1");
    expect(resolveRuntimeScriptEntrypointUrl("managedUpdateHandoff", directory)).toEqual(
      pathToFileURL(path.join(directory, "handoff.cjs")),
    );
  });
});

describe("resolveRuntimeDeployEntrypointUrl", () => {
  it.each([
    ["worker", "worker.mjs"],
    ["image-processor.worker", "image-processor.worker.mjs"],
  ] as const)("resolves %s in the selected bundle", async (name, fileName) => {
    const { resolveRuntimeDeployEntrypointUrl } = await import("./runtime-process-url.js");
    const directory = path.resolve("worker bundle #1");
    expect(resolveRuntimeDeployEntrypointUrl(name, directory)).toEqual(
      pathToFileURL(path.join(directory, fileName)),
    );
  });
});
