import { execFile } from "node:child_process";
import { copyFile, link, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { isNodeCompilerArg } from "../../node-runtime-env.mjs";
import "../test-utils/prepare-compiled-subprocesses.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
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
    ...(node ? process.execArgv.filter(isNodeCompilerArg) : ["--no-install"]),
    ...(needsLoader ? ["--import", loader] : []),
    fileURLToPath(url),
  ]);
  expect(resolveRuntimeWorkerThreadExecArgv(url, runtime)).toEqual(
    needsLoader
      ? ["--import", expect.stringMatching(/^file:.*\/infra\/runtime-worker-loader\.(?:mjs|js)$/)]
      : [],
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
        execArgv: { configurable: true, value: ["--no-opt", "--inspect"] },
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
        execArgv: descriptors.execArgv,
        execPath: descriptors.execPath,
        versions: descriptors.versions,
      });
    }
  });

  it("loads a TypeScript worker thread from a foreign working directory", async () => {
    await withTempDir("openclaw-worker-thread-cwd-", async (cwd) => {
      const entry = path.join(cwd, "thread.mts");
      await writeFile(
        entry,
        'import { parentPort } from "node:worker_threads"; enum Answer { value = 42 }; parentPort.postMessage(Answer.value);',
      );
      const url = pathToFileURL(entry);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { Worker } from "node:worker_threads"; const worker = new Worker(new URL(process.argv[1]), { execArgv: JSON.parse(process.argv[2]) }); worker.on("message", value => console.log(value));',
          url.href,
          JSON.stringify(resolveRuntimeWorkerThreadExecArgv(url)),
        ],
        { cwd, timeout: 10_000 },
      );
      expect(stdout.trim()).toBe("42");
    });
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

describe("parent compiler policy in OpenClaw-owned children", () => {
  // Each child records its own execArgv through a preload, as the broker fixtures do.
  const observer = `import { appendFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
if (isMainThread) appendFileSync(process.env.EXEC_ARGV_LOG, JSON.stringify([process.argv[1], process.execArgv]) + "\\n");`;
  const thread = `import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { workerData } from "node:worker_threads";
const { resolveRuntimeWorkerArgv } = await import(pathToFileURL(workerData.src + "/infra/runtime-worker-url.ts").href);
execFileSync(process.execPath, resolveRuntimeWorkerArgv(pathToFileURL(workerData.dir + "/thread-child.mjs")));`;
  const driver = `import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
const [dir, src] = process.argv.slice(1);
const load = (file) => import(pathToFileURL(src + "/" + file).href);
const { resolveRuntimeWorkerArgv } = await load("infra/runtime-worker-url.ts");
execFileSync(process.execPath, resolveRuntimeWorkerArgv(pathToFileURL(dir + "/child.mjs")));
const outputs = [resolveRuntimeWorkerArgv(pathToFileURL(dir + "/child.mjs"), "/opt/bun")];
const threadUrl = pathToFileURL(dir + "/thread.mts");
const { createCpuTrackedWorker } = await load("infra/worker-cpu.ts");
const worker = createCpuTrackedWorker(threadUrl, {
  execArgv: resolveRuntimeWorkerArgv(threadUrl).slice(0, -1),
  workerData: { dir, src },
});
await new Promise((resolve, reject) => worker.once("exit", resolve).once("error", reject));
// The SDK's documented thread execArgv for workspace workers must stay free of V8 flags.
const { resolveWorkspaceWorkerExecArgv } = await load("agents/workspace-worker.ts");
const { Worker } = await import("node:worker_threads");
await new Worker("", { eval: true, execArgv: resolveWorkspaceWorkerExecArgv("memory") }).terminate();
const broker = (await load("process/spawn-broker/host.ts")).createSpawnBrokerHost();
await broker.ready();
await broker.close();
new DatabaseSync(dir + "/state.sqlite").exec("CREATE TABLE t (x)");
const sqlite = await load("infra/sqlite-readonly-worker.ts");
sqlite.runSqliteReadOnlyWorkerSync(dir + "/state.sqlite", dir);
const session = sqlite.createScopedSqliteReadOnlyWorker({ ...sqlite.captureSqliteReadOnlyWorkerLaunch(), retainLifetime: false });
await session.run(dir + "/state.sqlite", { mode: "sync" });
await session.close();
const cli = await load("cli/update-cli/update-command-cli-options.ts");
await cli.readUpdateTargetCliOptions({ nodeRunner: process.execPath, entryPath: dir + "/cli.mjs", command: "doctor" }, {});
const { prepareRuntimeProcessScriptInvocation } = await load("infra/runtime-process-url.ts");
for (const name of ["updateStateSizes", "daemonRuntimeProbe"]) {
  const script = prepareRuntimeProcessScriptInvocation(name, process.execPath);
  outputs.push(JSON.parse(execFileSync(script.argv[0], script.argv.slice(1), { input: '{"files":[]}' })));
  script.dispose();
}
console.log(JSON.stringify(outputs));`;

  it("children observe the parent's flags; the probe's report does not change", async () => {
    const reports: unknown[] = [];
    for (const flags of [["--no-opt"], []]) {
      await withTempDir("openclaw-compiler-policy-", async (dir) => {
        for (const [name, source] of Object.entries({
          "observer.mjs": observer,
          "thread.mts": thread,
          "child.mjs": "",
          "thread-child.mjs": "",
          "cli.mjs": "",
        })) {
          await writeFile(path.join(dir, name), source);
        }
        const log = path.join(dir, "exec-argv.jsonl");
        // The suite may run on Bun; the parent under test is a real Node process.
        const { stdout } = await promisify(execFile)(
          resolveTestNodeExecPath(),
          [
            ...flags,
            "--no-warnings",
            "--import",
            import.meta.resolve("tsx"),
            "--input-type=module",
            "-e",
            driver,
            dir,
            fileURLToPath(new URL("..", import.meta.url)),
          ],
          {
            env: {
              ...process.env,
              EXEC_ARGV_LOG: log,
              NODE_OPTIONS: `--import=${pathToFileURL(path.join(dir, "observer.mjs")).href}`,
            },
          },
        );
        const [bunChildArgv, , report] = JSON.parse(stdout);
        expect(bunChildArgv).toEqual(["--no-install", path.join(dir, "child.mjs")]);
        reports.push(report);
        const logged = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as [string, string[]])
          .map(([entry, execArgv]) => [path.basename(entry ?? ""), execArgv] as const);
        const children = new Map(logged);
        // Exact for plain children: --no-warnings and the parent's loader stay behind.
        expect(children.get("child.mjs")).toEqual(flags);
        expect(children.get("thread-child.mjs")).toEqual(flags);
        expect(children.get("cli.mjs")).toEqual(flags);
        expect(children.get("update-state-sizes.mjs")).toEqual(flags);
        expect(children.get("daemon-runtime-probe.mjs")).toEqual(flags);
        // Source workers also carry their loader; only the reviewed flags must match the parent.
        // The one-shot and session readers each carry them once.
        const workerFlags = (worker: RegExp) =>
          logged
            .filter(([name]) => worker.test(name))
            .map(([, execArgv]) => execArgv.filter(isNodeCompilerArg));
        expect(workerFlags(/^worker\.[jt]s$/)).toEqual([flags]);
        expect(workerFlags(/^sqlite-readonly-location\.worker\.[jt]s$/)).toEqual([flags, flags]);
      });
    }
    // The probe reports the same runtime version and SQLite capability under either parent.
    expect(reports[0]).toEqual(reports[1]);
    expect(reports[0]).toMatchObject({ sqliteProbe: { available: true, text: true } });
  });
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
