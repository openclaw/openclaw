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
  resolveExternalPackageRuntimeEntrypointUrl as external,
  resolveRuntimeDeployEntrypointUrl as deploy,
  resolveRuntimeScriptEntrypointUrl as script,
} from "./runtime-process-url.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
  runtimeNeedsTypeScriptLoader,
} from "./runtime-worker-url.js";

const requireFromHere = createRequire(import.meta.url);
const fileUrl = (root: string, file: string) => pathToFileURL(path.join(root, file)).href;
function expectWorker(
  params: Parameters<typeof resolveRuntimeWorkerUrl>[0],
  root: string,
  expected: string,
) {
  expect(fileURLToPath(resolveRuntimeWorkerUrl(params))).toBe(path.join(root, expected));
}
function expectRuntimeArgs(
  extension: string,
  runtime: string | undefined,
  node: boolean,
  loader = import.meta.resolve("tsx"),
) {
  const url = pathToFileURL(path.resolve(`worker fixture.${extension}`));
  const needsLoader = node && extension.endsWith("ts");
  expect(resolveRuntimeWorkerArgv(url, runtime)).toEqual([
    ...(node ? [] : ["--no-install"]),
    ...(needsLoader ? ["--import", loader] : []),
    fileURLToPath(url),
  ]);
  expect(resolveRuntimeWorkerThreadExecArgv(url, runtime)).toEqual(
    needsLoader ? ["--import", import.meta.resolve("tsx/esm")] : [],
  );
  expect(runtimeNeedsTypeScriptLoader(fileURLToPath(url), runtime)).toBe(needsLoader);
}

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
    const entry = {
      currentModuleUrl: fileUrl(root, "src/agents/code-mode-worker.ts"),
      sourceWorkerName: "code-mode.worker",
      distWorkerPath: "agents/code-mode.worker.js",
    };
    expectWorker(entry, root, "src/agents/code-mode.worker.ts");
    expectWorker(
      { ...entry, sourceWorkerName: "generated.worker", sourceExtension: ".mjs" },
      root,
      "src/agents/generated.worker.mjs",
    );
    for (const modulePath of [
      "dist/agents/code-mode.js",
      "dist/selection-abc123.js",
      "dist/selection-abc123.mjs",
    ]) {
      const params = { ...entry, currentModuleUrl: fileUrl(root, modulePath) };
      expectWorker(params, root, "dist/agents/code-mode.worker.js");
      const candidateRoot = path.join(root, "candidate");
      expectWorker(
        { ...params, root: candidateRoot },
        candidateRoot,
        "dist/agents/code-mode.worker.js",
      );
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
          const params = { ...entry, currentModuleUrl: fileUrl(root, modulePath) };
          expectWorker(
            params,
            root,
            `dist/${packageName === entry.package.name ? entry.package.distWorkerPath : entry.distWorkerPath}`,
          );
          expectWorker({ ...params, root }, root, `dist/${entry.distWorkerPath}`);
        }
      }
      await writeFile(path.join(root, "package.json"), "invalid-json");
      expect(() =>
        resolveRuntimeWorkerUrl({
          ...entry,
          currentModuleUrl: fileUrl(root, "dist/index.js"),
        }),
      ).toThrow("Cannot resolve runtime worker package");
      expectWorker(
        { ...entry, currentModuleUrl: fileUrl(root, "src/entry.ts") },
        root,
        "src/store.worker.ts",
      );
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
      expectRuntimeArgs(
        extension,
        runtime,
        typescriptLoader,
        pathToFileURL(requireFromHere.resolve("tsx")).href,
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
        for (const { selected, typescriptLoader } of [
          { selected: undefined, typescriptLoader: !bun },
          { selected: currentExecutable, typescriptLoader: !bun },
          { selected: path.resolve("foreign-runtime-fixture", "node"), typescriptLoader: true },
          { selected: path.resolve("foreign-runtime-fixture", "bun"), typescriptLoader: false },
        ]) {
          expectRuntimeArgs(extension, selected, typescriptLoader);
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

it.each([
  ["src/entry.ts", external.bind(null, "sourceCli")],
  ["openclaw.mjs", external.bind(null, "cliLauncher")],
  ["scripts/preinstall-package-manager-warning.mjs", external.bind(null, "preinstall")],
  ["scripts/postinstall-bundled-plugins.mjs", external.bind(null, "postinstall")],
  ["handoff.cjs", script.bind(null, "managedUpdateHandoff")],
  ["worker.mjs", deploy.bind(null, "worker")],
  ["image-processor.worker.mjs", deploy.bind(null, "image-processor.worker")],
] as const)("resolves %s beneath the selected runtime root", (file, resolve) => {
  const directory = path.resolve("runtime directory #1 with spaces");
  expect(resolve(directory)).toEqual(pathToFileURL(path.join(directory, file)));
});
