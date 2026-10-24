import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { encodePngRgba } from "rastermill";
import * as tar from "tar";
import { build } from "tsdown";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import {
  createWorkerDeployBuildPlugin,
  resolveWorkerDeployGeneratorInputs,
  WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
} from "../../scripts/lib/worker-deploy-build-plugin.mts";
import { createWorkerBundleProducer } from "../../src/gateway/worker-environments/bundle.js";
import {
  WORKER_BUNDLE_ARTIFACT_PATHS,
  WORKER_BUNDLE_DARWIN_NATIVE_ARTIFACTS,
  WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH,
} from "../../src/shared/worker-bundle-hash.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("tsdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tsdown")>();
  return { ...actual, build: vi.fn(actual.build) };
});

// Runtime cases consume the prepared graph without spending their deadline compiling it.
beforeEach(() => {
  vi.mocked(build).mockClear();
});
afterEach(() => expect(build).not.toHaveBeenCalled());

const fail = (message: string): never => {
  throw new Error(message);
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workerEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
  };
}

describe("worker deploy build plugin", () => {
  it("tracks the pinned fs-safe manifest and lock before relocation", () => {
    expect(resolveWorkerDeployGeneratorInputs()).toEqual(
      expect.arrayContaining([
        fs.realpathSync(path.resolve("node_modules/@openclaw/fs-safe/package.json")),
        path.resolve("pnpm-lock.yaml"),
      ]),
    );
  });

  it.each(["", 'require("../package.json"); require("../package.json");'])(
    "rejects changed fs-safe native manifest lookup shape %#",
    (code) => {
      const nativePath = fs.realpathSync(
        path.resolve("node_modules/@openclaw/fs-safe/dist/native.js"),
      );
      expect(() =>
        createWorkerDeployBuildPlugin().transform.call({ error: fail }, code, nativePath),
      ).toThrow("fs-safe native manifest lookup changed");
    },
  );

  it.each(["escaped.mjs", "worker/runtime.wasm", "worker/unowned.exe"])(
    "rejects an unstaged emitted %s before publishing the worker graph",
    (fileName) => {
      const plugin = createWorkerDeployBuildPlugin();
      expect(() =>
        plugin.generateBundle.call(
          { error: fail },
          {},
          {
            "worker/worker.mjs": { type: "chunk", fileName: "worker/worker.mjs", isEntry: true },
            [fileName]: { type: fileName.endsWith(".mjs") ? "chunk" : "asset", fileName },
          },
        ),
      ).toThrow(`Worker deploy artifact emits unstaged runtime asset ${fileName}.`);
    },
  );

  describe("portable output", () => {
    const fixtureDirs = useAutoCleanupTempDirTracker(afterAll);
    const fixtureLifetime = createFixtureLifetime();
    const workerEntryNames = new Set(
      WORKER_BUNDLE_ARTIFACT_PATHS.filter((artifact) => artifact.endsWith(".mjs")).map(
        (artifact) => `worker/${artifact.replace(/\.mjs$/u, "")}`,
      ),
    );
    let preparedDist: string;
    let preparedArchive: string;

    afterEach(() => fixtureLifetime.cleanup());

    beforeAll(async () => {
      const { default: configs } = await import("../../tsdown.config.ts");
      const config = configs.find(
        (candidate) =>
          typeof candidate.entry === "object" &&
          !Array.isArray(candidate.entry) &&
          candidate.entry?.["worker/worker"] === "src/worker/worker-deploy-entry.ts",
      );
      if (!config) {
        throw new Error("Worker deploy build config is missing");
      }
      const root = fixtureDirs.make("openclaw-worker-complete-graph-");
      preparedDist = path.join(root, "dist");
      const entrySource = path.resolve("src/worker/worker-deploy-entry.ts");
      const highlightSource = fs.realpathSync(
        path.resolve("node_modules/highlight.js/lib/index.js"),
      );
      const activationSource = fs.realpathSync(
        path.resolve("src/plugin-sdk/facade-activation-check.runtime.ts"),
      );
      // Mixed runtime/declaration graphs also contain worker paths, but are not archived.
      for (const sibling of configs.filter(
        (candidate) =>
          candidate !== config &&
          // Declaration partitions repeat the root entries; they are not runtime siblings.
          !(typeof candidate.dts === "object" && candidate.dts.emitDtsOnly) &&
          typeof candidate.entry === "object" &&
          !Array.isArray(candidate.entry) &&
          Object.keys(candidate.entry).length > 0 &&
          Object.keys(candidate.entry).every((entry) => workerEntryNames.has(entry)),
      )) {
        const { bundles } = await build({
          ...sibling,
          config: false,
          outDir: preparedDist,
          clean: false,
          dts: false,
          logLevel: "silent",
        });
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
      }
      const { bundles } = await build({
        ...config,
        config: false,
        outDir: path.join(root, "dist"),
        clean: false,
        dts: false,
        logLevel: "silent",
        plugins: [
          config.plugins,
          {
            name: "test:worker-runtime-initialization",
            transform(code, id) {
              if (id === entrySource) {
                return `${code}
export { highlight, supportsLanguage } from "../agents/utils/syntax-highlight.js";
export { createOwnedStdioProcess, closeOwnedStdioProcess } from "../process/owned-stdio.js";
export { explainShellCommand } from "../infra/command-explainer/extract.js";
export { planShellAuthorization } from "../infra/exec-authorization-plan.js";
export { commitExecAuthorizationLocked } from "../infra/exec-approvals-authorization.js";
export { updateExecApprovals, readExecApprovalsSnapshot } from "../infra/exec-approvals-store.js";
export { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
export { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
export { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
export { readOpenClawDatabaseQuarantineFailure } from "../state/openclaw-quarantine-store.js";
export { seedOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.test-support.js";
export { readSecretStoreExecEnvironment } from "../secrets/store/secret-store.js";
export { rejectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
export { WebSocket } from "../../packages/gateway-client/src/websocket.js";
export { createComputerTool } from "../agents/tools/computer-tool.js";
export { createImageProcessor, convertBmpToPngWithWorker } from "../media/image-processor.js";
export { createReadTool } from "../agents/sessions/tools/read.js";
export { createEditTool } from "../agents/sessions/tools/edit.js";
export { createWriteTool } from "../agents/sessions/tools/write.js";
export { createWorkerPlacementTools } from "./worker-placement-tools.js";
export { createRealtimeTranscriptionWebSocketSession } from "../realtime-transcription/websocket-session.js";
export { runDesktopWebSocketRuntimeProbe } from "../gateway/desktop/websocket-runtime.test-support.js";
export { loadActivatedBundledPluginPublicSurfaceModuleSync, listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
export { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
export { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
export { getNativeFallbackDiagnostic } from ${JSON.stringify(pathToFileURL(fs.realpathSync(path.resolve("node_modules/@openclaw/fs-safe/dist/native.js"))).href)};
import { readOwnerAndDaclBatch as readBatch } from "@openclaw/fs-safe/permissions";
export function readOwnerAndDaclBatch(paths: readonly string[]) {
  return readBatch(paths);
}
export { inspectDarwinAcl } from "@openclaw/fs-safe/permissions";
export { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";`;
              }
              if (id === highlightSource) {
                return `globalThis[Symbol.for("worker-highlight-initializations")] = (globalThis[Symbol.for("worker-highlight-initializations")] ?? 0) + 1;\n${code}`;
              }
              if (id === activationSource) {
                return `globalThis[Symbol.for("worker-activation-initializations")] = (globalThis[Symbol.for("worker-activation-initializations")] ?? 0) + 1;\n${code}`;
              }
              return null;
            },
          },
        ],
      });
      try {
        const { collectWorkerDeployArtifactErrors } =
          await import("../../scripts/check-cli-bootstrap-imports.mts");
        expect(
          collectWorkerDeployArtifactErrors({
            rootDir: root,
          }),
        ).toEqual([]);
        preparedArchive = (
          await createWorkerBundleProducer({
            packageRoot: root,
            cacheDir: path.join(root, "cache"),
          }).prepare()
        ).tarballPath;
      } finally {
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
      }
    });

    it("denies workspace exec without a Gateway transcript worker in the archive", async () => {
      const root = tempDirs.make("openclaw-worker-exec-permission-");
      const relocated = path.join(root, "bundle");
      fs.mkdirSync(relocated);
      await tar.extract({ file: preparedArchive, cwd: relocated });
      expect(fs.existsSync(path.join(relocated, "session-transcript.worker.mjs"))).toBe(false);
      const result = await runNodeScript(
        [
          "--input-type=module",
          "--eval",
          `
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const entry = process.argv[1];
process.argv = [process.execPath, entry, "--internal-worker-prewarm"];
const { createWorkerPlacementTools, closeOpenClawStateDatabaseAsync } = await import(pathToFileURL(entry).href);
try {
  const exec = createWorkerPlacementTools({
    policy: {
      workspaceOnly: true, readOnly: false, applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true, imageSanitization: {},
    }, cwd: process.cwd(), containmentRoot: process.cwd(),
    execAuthority: { host: "gateway", security: "full", ask: "off" },
    permissionMode: "workspace", agentId: "main", sessionKey: "worker:permission-proof",
    sessionId: "permission-proof", runId: "permission-proof-run",
    github: {
      credentialScrubEnv: {}, localIdentityEnv: {}, excludedStoreNames: [], managedLocalIdentity: true,
    },
  }).find(tool => tool.name === "exec");
  const result = await exec.execute("permission-proof", { command: "echo permission-proof" });
  assert.match(JSON.stringify(result), /approval_required.*worker workspace permission mode/is);
  console.log("relocated worker exec permission denied without Gateway storage");
} finally {
  await closeOpenClawStateDatabaseAsync();
}
`,
          path.join(relocated, "worker.mjs"),
        ],
        {
          ...workerEnv(root),
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        30_000,
        { cwd: root },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        "relocated worker exec permission denied without Gateway storage",
      );
    });

    it(
      "reads local credentials and commits authorization through SQLite workers in a relocated archive",
      ({ signal }) =>
        fixtureLifetime.run(async () => {
          const root = fixtureLifetime.createTempDir("openclaw-worker-exec-authorization-");
          const relocated = path.join(root, "dist", "worker");
          fs.mkdirSync(relocated, { recursive: true });
          await tar.extract({ file: preparedArchive, cwd: relocated });
          expect(
            fs.readFileSync(path.join(relocated, WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH)),
          ).toEqual(
            fs.readFileSync(
              path.resolve(
                "node_modules/@openclaw/fs-safe/dist",
                WORKER_BUNDLE_WINDOWS_SECURITY_HELPER_PATH,
              ),
            ),
          );
          const result = await fixtureLifetime.track(
            runNodeScript(
              [
                "--input-type=module",
                "--eval",
                `
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const entry = process.argv[1];
process.argv = [process.execPath, entry, "--internal-worker-prewarm"];
const {
  commitExecAuthorizationLocked,
  loadOrCreateDeviceIdentity,
  updateExecApprovals,
  readExecApprovalsSnapshot,
  readSecretStoreExecEnvironment,
  closeOpenClawStateDatabaseAsync,
  resolveOpenClawStateSqlitePath,
  readStableSqliteFileGeneration,
  seedOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
} = await import(pathToFileURL(entry).href);
const match = { id: "portable-exec", pattern: process.execPath };
const command = "portable exec authorization";
try {
  const identity = loadOrCreateDeviceIdentity();
  assert.equal(identity.deviceId.length, 64);
  assert.deepEqual(loadOrCreateDeviceIdentity(), identity);
  await updateExecApprovals({ update: { kind: "replace", file: { version: 1, defaults: { security: "full", ask: "off" }, agents: { main: { allowlist: [match] } } } } });
  assert.deepEqual(await readSecretStoreExecEnvironment({ includeSecretSentinels: false }), {});
  const assertCurrent = await commitExecAuthorizationLocked({
    agentId: "main", matches: [match], command, resolvedPath: process.execPath,
    authorization: { source: "current-policy", security: "full", ask: "off", allowlistSatisfied: true },
  });
  assertCurrent();
  console.log("relocated exec authorization committed");
  await closeOpenClawStateDatabaseAsync();
  const stored = readExecApprovalsSnapshot().file.agents.main.allowlist[0];
  assert.equal(stored.lastUsedCommand, command);
  assert.equal(stored.lastResolvedPath, process.execPath);
  assert.ok(stored.lastUsedAt > 0);
  await closeOpenClawStateDatabaseAsync();
  const statePath = resolveOpenClawStateSqlitePath();
  seedOpenClawDatabaseQuarantine({
    kind: "state", path: statePath, reason: "portable integrity failure",
    generation: readStableSqliteFileGeneration(statePath),
  });
  assert.equal(readOpenClawDatabaseQuarantineFailure("state", statePath)?.name, "SqliteIntegrityError");
  await assert.rejects(
    updateExecApprovals({ update: { kind: "replace", file: { version: 1, defaults: { security: "deny", ask: "off" } } } }),
    /quarantined after integrity verification failed/,
  );
} finally {
  await closeOpenClawStateDatabaseAsync();
}
console.log("relocated exec authorization persisted");
`,
                path.join(relocated, "worker.mjs"),
              ],
              {
                ...workerEnv(root),
                OPENCLAW_STATE_DIR: path.join(root, "state"),
              },
              30_000,
              { cwd: root, signal },
            ),
          );
          const diagnostics = `${result.stderr}\n${result.stdout}`;
          expect(result.error, diagnostics).toBeUndefined();
          expect(result.status, diagnostics).toBe(0);
          expect(result.stdout).toContain("relocated exec authorization committed");
          expect(result.stdout).toContain("relocated exec authorization persisted");
        }),
      180_000,
    );

    it.skipIf(process.platform !== "darwin").for(["missing", "tampered"] as const)(
      "refuses %s archive-owned native credentials without a host fallback",
      { timeout: 180_000 },
      async (fault, { signal }) =>
        fixtureLifetime.run(async () => {
          const root = fixtureLifetime.createTempDir("openclaw-worker-native-refusal-");
          const relocated = path.join(root, "bundle");
          fs.mkdirSync(relocated);
          await tar.extract({ file: preparedArchive, cwd: relocated });
          const asset =
            process.arch === "arm64"
              ? WORKER_BUNDLE_DARWIN_NATIVE_ARTIFACTS["darwin-arm64"]
              : WORKER_BUNDLE_DARWIN_NATIVE_ARTIFACTS["darwin-x64"];
          const assetPath = path.join(relocated, asset);
          if (fault === "missing") {
            fs.unlinkSync(assetPath);
          } else {
            fs.writeFileSync(assetPath, "tampered native addon");
          }
          const result = await fixtureLifetime.track(
            runNodeScript(
              [
                "--input-type=module",
                "--eval",
                `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [entry, fault] = process.argv.slice(1);
const require = createRequire(pathToFileURL(entry));
assert.throws(() => require.resolve("@openclaw/fs-safe-darwin-" + process.arch), { code: "MODULE_NOT_FOUND" });
process.argv = [process.execPath, entry, "--internal-worker-prewarm"];
const { loadOrCreateDeviceIdentity, getNativeFallbackDiagnostic } = await import(pathToFileURL(entry).href);
assert.throws(() => loadOrCreateDeviceIdentity(), error => {
  assert.equal(error.code, "helper-unavailable");
  if (fault === "missing") assert.equal(error.cause?.code, "ENOENT");
  else assert.match(error.cause?.message ?? "", /native asset integrity mismatch/);
  return true;
});
assert.equal(getNativeFallbackDiagnostic().reason, "load-failed");
assert.equal(fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR, "client", "credentials.sqlite")), false);
assert.deepEqual(Object.keys(require.cache).filter(file => file.endsWith(".node")), []);
console.log("archive-owned native credentials refused " + fault);
`,
                path.join(relocated, "worker.mjs"),
                fault,
              ],
              {
                PATH: process.env.PATH,
                HOME: root,
                OPENCLAW_STATE_DIR: path.join(root, "state"),
                TMPDIR: root,
                NODE_DISABLE_COMPILE_CACHE: "1",
              },
              30_000,
              { cwd: root, signal },
            ),
          );
          const diagnostics = `${result.stderr}\n${result.stdout}`;
          expect(result.error, diagnostics).toBeUndefined();
          expect(result.status, diagnostics).toBe(0);
          expect(result.stdout.trim()).toBe(`archive-owned native credentials refused ${fault}`);
        }),
    );

    it(
      "keeps activated plugin facades lazy and config-aware in a relocated archive",
      ({ signal }) =>
        fixtureLifetime.run(async () => {
          const root = fixtureLifetime.createTempDir("openclaw-worker-facade-");
          const packageRoot = path.join(root, "pkg");
          const relocated = path.join(packageRoot, "dist/worker");
          const bundledRoot = path.join(packageRoot, "dist/extensions");
          const pluginRoot = path.join(bundledRoot, "fixture");
          fs.mkdirSync(relocated, { recursive: true });
          fs.mkdirSync(pluginRoot, { recursive: true });
          fs.writeFileSync(
            path.join(packageRoot, "package.json"),
            JSON.stringify({ name: "openclaw", version: "0.0.0", type: "module" }),
          );
          await tar.extract({ file: preparedArchive, cwd: relocated });
          fs.writeFileSync(
            path.join(pluginRoot, "package.json"),
            JSON.stringify({
              name: "@openclaw/worker-facade-fixture",
              version: "0.0.0",
              type: "module",
              openclaw: { extensions: ["./index.js"] },
            }),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "openclaw.plugin.json"),
            JSON.stringify({
              id: "worker-facade-owner",
              enabledByDefault: true,
              channels: [],
              configSchema: { type: "object", additionalProperties: false, properties: {} },
            }),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "index.js"),
            'export default { id: "worker-facade-owner", register() {} };\n',
          );
          fs.writeFileSync(
            path.join(pluginRoot, "api.js"),
            `globalThis[Symbol.for("worker-facade-evaluations")] = (globalThis[Symbol.for("worker-facade-evaluations")] ?? 0) + 1;
export const marker = "relocated";`,
          );
          const result = await fixtureLifetime.track(
            runNodeScript(
              [
                "--input-type=module",
                "--eval",
                `
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const entry = process.argv[1];
process.argv = [process.execPath, entry, "--internal-worker-prewarm"];
const {
  loadActivatedBundledPluginPublicSurfaceModuleSync: load,
  listImportedBundledPluginFacadeIds,
  setRuntimeConfigSnapshot,
  getFsSafeNativeConfig,
  getNativeFallbackDiagnostic,
  inspectDarwinAcl,
  readOwnerAndDaclBatch,
} = await import(pathToFileURL(entry).href);
const { Worker } = await import("node:worker_threads");
const { once } = await import("node:events");
const watcher = new Worker(new URL("./worker-chunk-fs-safe-watch-io.mjs", pathToFileURL(entry)), {
  execArgv: [],
  workerData: { native: getFsSafeNativeConfig(), diagnostics: false },
});
try {
  const reply = once(watcher, "message");
  watcher.postMessage({ id: 1, method: "metrics", args: [] });
  assert.deepEqual((await reply)[0], { id: 1, value: {}, cleanupErrors: [] });
} finally {
  await watcher.terminate();
}
assert.equal(getFsSafeNativeConfig().mode, process.platform === "darwin" ? "require" : "off");
if (process.platform === "darwin") {
  assert.deepEqual(inspectDarwinAcl(entry), { kind: "none" });
}
const diagnostic = getNativeFallbackDiagnostic("inspectDarwinAcl");
assert.equal(diagnostic.reason, process.platform === "darwin" ? "loaded" : "disabled");
if (diagnostic.packageName) {
  const versions = ${JSON.stringify(JSON.parse(fs.readFileSync(path.resolve("node_modules/@openclaw/fs-safe/package.json"), "utf8")).optionalDependencies)};
  assert.equal(diagnostic.packageVersion, versions[diagnostic.packageName]);
}
assert.deepEqual(await readOwnerAndDaclBatch([]), []);
if (process.platform !== "win32") {
  assert.deepEqual(await readOwnerAndDaclBatch([entry]), [{
    status: "unsupported-platform", platform: process.platform,
  }]);
}
const initializations = () => globalThis[Symbol.for("worker-activation-initializations")] ?? 0;
const evaluations = () => globalThis[Symbol.for("worker-facade-evaluations")] ?? 0;
assert.equal(initializations(), 0, "worker bootstrap must not initialize facade activation");
const params = { dirName: "fixture", artifactBasename: "api.js" };
const disabled = { plugins: { entries: { "worker-facade-owner": { enabled: false } } } };
setRuntimeConfigSnapshot(disabled);
assert.throws(() => load(params), /disabled in config/);
assert.equal(initializations(), 1, "first access must initialize bundled facade activation once");
assert.equal(evaluations(), 0, "disabled facade must not evaluate its public artifact");
assert.deepEqual(listImportedBundledPluginFacadeIds(), []);
setRuntimeConfigSnapshot({});
const loaded = load(params);
assert.equal(loaded.marker, "relocated");
assert.strictEqual(load(params), loaded);
assert.equal(evaluations(), 1);
assert.deepEqual(listImportedBundledPluginFacadeIds(), ["worker-facade-owner"]);
setRuntimeConfigSnapshot(disabled);
assert.throws(() => load(params), /disabled in config/);
assert.equal(initializations(), 1);
assert.equal(evaluations(), 1);
console.log("relocated worker facade activation follows the shared config snapshot");
`,
                path.join(relocated, "worker.mjs"),
              ],
              {
                ...workerEnv(root),
                OPENCLAW_HOME: root,
                OPENCLAW_STATE_DIR: path.join(root, "state"),
                OPENCLAW_CONFIG_PATH: path.join(root, "missing-config.json"),
                OPENCLAW_FS_SAFE_NATIVE_MODE: "require",
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
                XDG_CONFIG_HOME: path.join(root, "config"),
                XDG_CACHE_HOME: path.join(root, "cache"),
                XDG_DATA_HOME: path.join(root, "data"),
                JITI_FS_CACHE: "0",
                NODE_DISABLE_COMPILE_CACHE: "1",
              },
              30_000,
              {
                cwd: packageRoot,
                signal,
                requireProcessTreeExit: process.platform !== "win32",
                maxBuffer: 64 * 1024,
              },
            ),
          );
          expect(result.error, `${root}\n${result.stderr}`).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout.trim()).toBe(
            "relocated worker facade activation follows the shared config snapshot",
          );

          // Check the deployed archive, not only the build directory: an emitted
          // auxiliary can exist locally but still be excluded by sealed staging.
          const closure = await fixtureLifetime.track(
            runNodeScript(
              [path.resolve("scripts/check-package-dist-imports.mjs"), packageRoot],
              {
                PATH: process.env.PATH,
                SystemRoot: process.env.SystemRoot,
                WINDIR: process.env.WINDIR,
              },
              30_000,
              { cwd: packageRoot, signal, requireProcessTreeExit: process.platform !== "win32" },
            ),
          );
          expect(closure.error, closure.stderr).toBeUndefined();
          expect(closure.status, closure.stderr).toBe(0);
          expect(closure.stdout.trim()).toBe("OpenClaw package dist import closure passed.");
        }),
      180_000,
    );

    it("delivers image operations and file reads and edits from a relocated archive", async () => {
      const root = tempDirs.make("openclaw-worker-images-");
      const relocated = path.join(root, "bundle");
      fs.mkdirSync(relocated);
      await tar.extract({ file: preparedArchive, cwd: relocated });
      fs.writeFileSync(
        path.join(root, "window.png"),
        encodePngRgba(new Uint8Array(1500 * 934 * 4).fill(255), 1500, 934, 1),
      );
      const result = await promisify(execFile)(
        process.execPath,
        [
          ...(process.versions.bun ? ["--no-install"] : []),
          "--input-type=module",
          "--eval",
          `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [entry, imagePath] = process.argv.slice(1);
for (const dependency of ["rastermill", "@silvia-odwyer/photon-node", "diff"]) {
  assert.throws(() => createRequire(pathToFileURL(entry)).resolve(dependency), { code: "MODULE_NOT_FOUND" });
}
process.argv = [process.execPath, entry, "--internal-worker-prewarm"];
const { createComputerTool, createImageProcessor, convertBmpToPngWithWorker, createReadTool, createEditTool, createWriteTool } = await import(pathToFileURL(entry).href);
const input = fs.readFileSync(imagePath);
try {
const filePath = imagePath + ".txt";
const written = await createWriteTool(process.cwd()).execute("portable-write", {
  path: filePath, content: "const label = “hello”; // keep — unchanged\\n",
});
assert.equal(written.details.created, true);
assert.match(written.details.patch, /\\+const label = “hello”/);
const edited = await createEditTool(process.cwd()).execute("portable-edit", {
  path: filePath,
  edits: [{ oldText: 'const label = "hello";', newText: 'const label = "hi";' }],
});
assert.equal(edited.details.changed, true);
assert.match(edited.details.diff, /\\+1 const label = "hi"; \\/\\/ keep — unchanged/);
assert.equal(fs.readFileSync(filePath, "utf8"), 'const label = "hi"; // keep — unchanged\\n');
for (const extension of [".txt", ".sqlite"]) {
  const readPath = imagePath + extension;
  fs.writeFileSync(readPath, "portable file read\\n");
  const read = await createReadTool(process.cwd()).execute("portable-read", { path: readPath });
  assert.ok(read.content.some(block => block.type === "text" && block.text.includes("portable file read")));
}
const inputs = [];
const computer = createComputerTool({
  transport: {
    computerUse: {
      contractVersion: 2,
      provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
      actions: ["get_window_state", "left_click"],
      targets: ["window"],
      deliveryModes: ["foreground"],
      observations: ["image"],
      features: { recording: false, agentCursor: false, multiDisplay: false },
    },
    resolveNode: async () => ({ nodeId: "synthetic-node" }),
    invoke: async ({ commandParams }) => {
      inputs.push(commandParams);
      return {
        ok: true,
        details: { coordinateSpace: "image-pixels" },
        observation: { kind: "window", observationId: "window-observation", base64: input.toString("base64"), format: "png", width: 1500, height: 934 },
      };
    },
  },
});
for (let index = 0; index < 3; index++) {
  const projected = await computer.execute("portable-observe-" + index, {
    action: "get_window_state", windowRef: "window-1",
  });
  const images = projected.content.filter(block => block.type === "image");
  assert.equal(images.length, 1, JSON.stringify(projected.content));
  const observation = JSON.parse(projected.content[0].text).observation;
  assert.equal(observation.width, 1200);
  assert.equal(observation.height, 747);
  assert.equal(observation.base64, "[image]");
}
await computer.execute("portable-click", {
  action: "left_click", windowRef: "window-1", observationId: "window-observation", coordinate: [400, 300],
});
assert.equal(inputs.at(-1).x, 500);
assert.equal(inputs.at(-1).y, 300 * (934 / 747));
assert.deepEqual(await createImageProcessor().transparency(input), { hasAlphaChannel: true, hasTransparentPixels: false });
const bmp = Buffer.from("424d3e0000000000000036000000280000000200000001000000010018000000000008000000000000000000000000000000000000000000ff00ff000000", "hex");
const png = await convertBmpToPngWithWorker(bmp);
const metadata = await createImageProcessor().probe(png);
assert.equal(metadata.width, 2);
assert.equal(metadata.height, 1);
assert.equal(metadata.format, "png");
console.log("relocated computer observations, image operations, and file reads and edits passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
`,
          path.join(relocated, "worker.mjs"),
          path.join(root, "window.png"),
        ],
        {
          cwd: relocated,
          timeout: 30_000,
          env: workerEnv(root),
        },
      );
      expect(result.stdout).toContain(
        "relocated computer observations, image operations, and file reads and edits passed",
      );
    }, 180_000);

    it("keeps worker bootstrap, shell analysis, and Windows child spawning portable", async () => {
      const root = tempDirs.make("openclaw-worker-portable-");
      fs.cpSync(preparedDist, path.join(root, "dist"), { recursive: true });
      const result = await promisify(execFile)(
        process.execPath,
        [
          ...(process.versions.bun ? ["--no-install"] : []),
          "--input-type=module",
          "--eval",
          `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const entry = process.argv[1];
for (const dependency of ["highlight.js", "web-tree-sitter", "tree-sitter-bash"]) {
  assert.throws(() => createRequire(pathToFileURL(entry)).resolve(dependency), { code: "MODULE_NOT_FOUND" });
}
process.argv = [process.execPath, entry, "--internal-worker-prewarm"];
const { highlight, supportsLanguage, explainShellCommand, planShellAuthorization, rejectUnsafeExecControlShellCommand, createOwnedStdioProcess, closeOwnedStdioProcess } = await import(pathToFileURL(entry).href);
const initializations = () => globalThis[Symbol.for("worker-highlight-initializations")] ?? 0;
assert.equal(initializations(), 0, "headless worker bootstrap must not initialize syntax highlighting");
assert.equal(supportsLanguage("abnf"), true);
assert.equal(supportsLanguage("javascript"), true);
assert.match(highlight("const answer = 42;", "javascript", {
  keyword: text => "[" + text + "]",
}), /\\[const\\]/);
assert.equal(initializations(), 1, "rendering must initialize the bundled highlighter only once");
const explanation = await explainShellCommand('printf "%s" "$(whoami)" | cat');
assert.equal(explanation.ok, true);
assert.deepEqual(explanation.topLevelCommands.map(step => step.executable), ["printf", "cat"]);
assert.deepEqual(explanation.nestedCommands.map(step => step.executable), ["whoami"]);
assert.equal((await planShellAuthorization({ command: 'printf "%s" safe | cat', cwd: process.cwd() })).ok, true);
await rejectUnsafeExecControlShellCommand('printf "%s" safe');
await assert.rejects(
  () => rejectUnsafeExecControlShellCommand('echo $(/approve synthetic allow-once)'),
  /exec cannot run \\/approve commands/,
);
if (process.platform === "win32") {
  assert.throws(() => createRequire(pathToFileURL(entry)).resolve("koffi"), { code: "MODULE_NOT_FOUND" });
  const owned = await createOwnedStdioProcess({
    argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"], exactEnv: true,
  });
  let output = "";
  owned.onStdout(chunk => { output += chunk; });
  owned.onStderr(() => {});
  owned.stdin.write("portable echo");
  owned.stdin.end();
  try {
    assert.equal((await owned.wait()).code, 0);
    assert.equal(output, "portable echo");
    assert.deepEqual(await owned.waitForExtinction(), { status: "uncertain", reason: "job-unavailable" });
    await closeOwnedStdioProcess(owned);
  } finally {
    owned.dispose();
  }
}
console.log("portable worker highlighting and shell analysis passed");
`,
          path.join(root, "dist/worker/worker.mjs"),
        ],
        {
          cwd: root,
          timeout: 30_000,
          env: workerEnv(root),
        },
      );
      expect(result.stdout.trim()).toBe("portable worker highlighting and shell analysis passed");
      expect(result.stderr).toBe("");
    });

    it("preserves WebSocket, desktop, and lazy transcription in relocated worker output", async () => {
      const root = tempDirs.make("openclaw-worker-websocket-");
      const output = path.join(root, "output");
      const relocated = path.join(root, "relocated");
      fs.cpSync(preparedDist, output, { recursive: true });
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const requests: Array<{ path: string | undefined; header: string | string[] | undefined }> =
        [];
      const closes: Promise<unknown>[] = [];
      server.on("connection", (socket, request) => {
        requests.push({ path: request.url, header: request.headers["x-worker-proof"] });
        closes.push(once(socket, "close"));
        socket.on("message", (data) => {
          const text = rawDataToString(data);
          if (request.url === "/transcription") {
            socket.send(JSON.stringify({ transcript: text }));
          } else {
            socket.send(text);
          }
        });
      });
      try {
        await once(server, "listening");
        const address = server.address();
        expect(address && typeof address === "object").toBeTruthy();
        if (!address || typeof address === "string") {
          throw new Error("WebSocket proof server has no bound port");
        }
        fs.renameSync(output, relocated);
        const probe = `
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [entry, url] = process.argv.slice(1);
process.argv = [process.execPath, entry, "--internal-worker-prewarm"];
assert.throws(() => createRequire(pathToFileURL(entry)).resolve("ws/package.json"), { code: "MODULE_NOT_FOUND" });
const { WebSocket, createRealtimeTranscriptionWebSocketSession, runDesktopWebSocketRuntimeProbe } = await import(pathToFileURL(entry).href);
for (const mode of ["observer-close", "observer-backpressure", "observer-payload", "desktop", "portal"]) {
  await runDesktopWebSocketRuntimeProbe(mode);
}
const socket = new WebSocket(url + "/client", { headers: { "x-worker-proof": "client-header" } });
await once(socket, "open");
const message = once(socket, "message");
socket.send("worker echo");
assert.equal((await message)[0].toString(), "worker echo");
const closed = once(socket, "close");
socket.close(1000, "proof complete");
assert.equal((await closed)[0], 1000);
let resolveTranscript, rejectTranscript;
const transcript = new Promise((resolve, reject) => { resolveTranscript = resolve; rejectTranscript = reject; });
const session = createRealtimeTranscriptionWebSocketSession({
  providerId: "fixture", url: url + "/transcription", readyOnOpen: true,
  headers: { "x-worker-proof": "transcription-header" },
  callbacks: { onError: rejectTranscript },
  sendAudio: (audio, transport) => transport.sendBinary(audio),
  onMessage: event => resolveTranscript(event.transcript),
  onClose: transport => transport.closeNow(),
});
try {
  await session.connect();
  assert.equal(session.isConnected(), true);
  session.sendAudio(Buffer.from("worker audio"));
  assert.equal(await transcript, "worker audio");
} finally { session.close(); }
console.log("relocated worker WebSocket and transcription passed");
`;
        const result = await runNodeScript(
          [
            "--input-type=module",
            "--eval",
            probe,
            path.join(relocated, "worker/worker.mjs"),
            `ws://127.0.0.1:${address.port}`,
          ],
          workerEnv(root),
          30_000,
          { cwd: relocated },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("relocated worker WebSocket and transcription passed");
        expect(requests).toEqual([
          { path: "/client", header: "client-header" },
          { path: "/transcription", header: "transcription-header" },
        ]);
        await Promise.all(closes);
      } finally {
        for (const client of server.clients) {
          client.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });

  it("replaces optional host-native modules with a failing virtual module", () => {
    const plugin = createWorkerDeployBuildPlugin();

    expect(plugin.load(WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID)).toContain(
      "optional host-native dependency unavailable",
    );
  });

  it("initializes the composed Browser runtime only when its factory is called", async () => {
    const bridgePath = path.resolve("src/worker/worker-deploy-browser-runtime.ts");
    const source = fs.readFileSync(bridgePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, bridgePath);
    if (transformed === null) {
      throw new Error("Browser runtime source was not transformed");
    }

    const root = tempDirs.make("openclaw-worker-browser-composition-");
    const outputPath = path.join(root, "src/worker/browser.mjs");
    const runtimePath = path.join(root, "extensions/browser/runtime-api.js");
    const eventsPath = path.join(root, "events.txt");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(outputPath, typeof transformed === "string" ? transformed : transformed.code);
    fs.writeFileSync(
      runtimePath,
      `import { appendFileSync } from "node:fs";
const record = event => appendFileSync(${JSON.stringify(eventsPath)}, event + "\\n");
record("initialized");
export async function createAttachedBrowserToolRuntime(params) {
  await params.ensureAttachTarget();
  return { tool: params, dispose: async () => record("disposed") };
}`,
    );

    const { default: browser } = await import(pathToFileURL(outputPath).href);
    expect(fs.existsSync(eventsPath)).toBe(false);
    let attached = 0;
    const params = {
      cdpUrl: "http://127.0.0.1:9222",
      ensureAttachTarget: async () => {
        attached += 1;
      },
      agentSessionKey: "agent:worker-agent:worker:session-1",
      agentDir: path.join(root, "agent"),
      workspaceDir: path.join(root, "workspace"),
    };
    const [first, second] = await Promise.all([
      browser.createAttachedBrowserToolRuntime(params),
      browser.createAttachedBrowserToolRuntime(params),
    ]);
    expect(attached).toBe(2);
    expect(first.tool).toBe(params);
    expect(second.tool).toBe(params);
    expect(fs.readFileSync(eventsPath, "utf8")).toBe("initialized\n");
    await first.dispose();
    await second.dispose();
    expect(fs.readFileSync(eventsPath, "utf8")).toBe("initialized\ndisposed\ndisposed\n");
  });

  it("embeds the Playwright package identity and browser registry", () => {
    const modulePath = path.resolve("node_modules/playwright-core/lib/coreBundle.js");
    const transformed = createWorkerDeployBuildPlugin().transform.call(
      { error: fail },
      fs.readFileSync(modulePath, "utf8"),
      modulePath,
    );
    expect(transformed).toContain('packageJSON = {"name":"playwright-core","version":"1.64.1"};');
    expect(transformed).toContain(
      'registry = new Registry({"comment":"Do not edit this file, use utils/roll_browser.js"',
    );
    expect(transformed).not.toContain(
      'require(import_path8.default.join(packageRoot, "package.json"))',
    );
    expect(transformed).not.toContain(
      'require(import_path19.default.join(packageRoot, "browsers.json"))',
    );
  });

  it.each([
    {
      name: "fs-safe watch worker",
      modulePath: "node_modules/@openclaw/fs-safe/dist/watch-io.js",
      mutate: (source: string) => source.replace("./watch-io-worker.js", "./changed-worker.js"),
      error: "fs-safe watch worker bootstrap changed",
    },
    {
      name: "fs-safe native batch",
      modulePath: "node_modules/@openclaw/fs-safe/dist/windows-security-command.js",
      mutate: (source: string) =>
        source.replace("if (options.native) {", "if (options.nativeBatch) {"),
      error: "fs-safe native batch bootstrap changed",
    },
    {
      name: "undici dispatcher",
      modulePath: "src/infra/net/undici-dispatcher-options.ts",
      mutate: (source: string) =>
        source.replace('requireUndici("undici/index.js")', 'changedUndici("undici/index.js")'),
      error: "undici dispatcher bootstrap changed",
    },
    {
      name: "Playwright package",
      modulePath: "node_modules/playwright-core/lib/coreBundle.js",
      mutate: () => "changed upstream source",
      error: "playwright-core package bootstrap changed",
    },
  ])("fails closed when the $name bootstrap shape changes", ({ modulePath, mutate, error }) => {
    const resolvedId = path.resolve(modulePath);
    const source = mutate(fs.readFileSync(resolvedId, "utf8"));
    const plugin = createWorkerDeployBuildPlugin();
    expect(() => plugin.transform.call({ error: fail }, source, resolvedId)).toThrow(error);
  });
});
