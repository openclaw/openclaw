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
  WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
} from "../../scripts/lib/worker-deploy-build-plugin.mts";
import { createWorkerBundleProducer } from "../../src/gateway/worker-environments/bundle.js";
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

describe("worker deploy build plugin", () => {
  it.each(["escaped.mjs", "worker/extra.mjs", "worker/native.node", "worker/runtime.wasm"])(
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
      for (const sibling of configs.filter(
        (candidate) =>
          candidate !== config &&
          typeof candidate.entry === "object" &&
          !Array.isArray(candidate.entry) &&
          Object.keys(candidate.entry).some((entry) => entry.startsWith("worker/")),
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
export { rejectUnsafeExecControlShellCommand } from "../infra/exec-control-command-guard.js";
export { WebSocket } from "../../packages/gateway-client/src/websocket.js";
export { projectComputerActResult } from "../agents/tools/computer-tool-result.js";
export { createImageProcessor, convertBmpToPngWithWorker } from "../media/image-processor.js";
export { createRealtimeTranscriptionWebSocketSession } from "../realtime-transcription/websocket-session.js";
export { runDesktopWebSocketRuntimeProbe } from "../gateway/desktop/websocket-runtime.test-support.js";
export { loadActivatedBundledPluginPublicSurfaceModuleSync, listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
export { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";`;
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
        // A dynamic import cycle can leave an unstaged root facade even with code splitting off.
        expect(bundles.flatMap((bundle) => bundle.chunks.map((chunk) => chunk.fileName))).toEqual([
          "worker/worker.mjs",
        ]);
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

    it("keeps activated plugin facades lazy and config-aware in a relocated archive", ({
      signal,
    }) =>
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
} = await import(pathToFileURL(entry).href);
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
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
              HOME: root,
              USERPROFILE: root,
              TMPDIR: root,
              TMP: root,
              TEMP: root,
              OPENCLAW_HOME: root,
              OPENCLAW_STATE_DIR: path.join(root, "state"),
              OPENCLAW_CONFIG_PATH: path.join(root, "missing-config.json"),
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

        const { collectPackageDistImportErrors } =
          await import("../../scripts/lib/package-dist-imports.mjs");
        const preparedRoot = path.dirname(preparedDist);
        const files = fs
          .readdirSync(preparedDist, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) =>
            path
              .relative(preparedRoot, path.join(entry.parentPath, entry.name))
              .replaceAll("\\", "/"),
          );
        expect(
          collectPackageDistImportErrors({
            files,
            readText: (relativePath) =>
              fs.readFileSync(path.join(preparedRoot, relativePath), "utf8"),
          }),
        ).toEqual([]);
      }));

    it("delivers resized computer observations and image operations from a relocated archive", async () => {
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
          "--input-type=module",
          "--eval",
          `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [entry, imagePath] = process.argv.slice(1);
for (const dependency of ["rastermill", "@silvia-odwyer/photon-node"]) {
  assert.throws(() => createRequire(pathToFileURL(entry)).resolve(dependency), { code: "MODULE_NOT_FOUND" });
}
process.argv = [process.execPath, entry, "--internal-worker-prewarm"];
const { projectComputerActResult, createImageProcessor, convertBmpToPngWithWorker } = await import(pathToFileURL(entry).href);
const input = fs.readFileSync(imagePath);
try {
for (let index = 0; index < 3; index++) {
  const projected = await projectComputerActResult({
    action: "get_window_state",
    target: { host: "node", nodeId: "synthetic-node", screenIndex: 0 },
    referenceWidth: 1200,
    result: {
      ok: true,
      details: { coordinateSpace: "image-pixels" },
      observation: { kind: "window", base64: input.toString("base64"), format: "png", width: 1500, height: 934 },
    },
  });
  const images = projected.result.content.filter(block => block.type === "image");
  assert.equal(images.length, 1, JSON.stringify(projected.result.content));
  const observation = JSON.parse(projected.result.content[0].text).observation;
  assert.equal(observation.width, 1200);
  assert.equal(observation.height, 747);
  assert.equal(observation.base64, "[image]");
  assert.deepEqual(projected.imageCoordinates, { kind: "available", scaleX: 1.25, scaleY: 934 / 747 });
}
assert.deepEqual(await createImageProcessor().transparency(input), { hasAlphaChannel: true, hasTransparentPixels: false });
const bmp = Buffer.from("424d3e0000000000000036000000280000000200000001000000010018000000000008000000000000000000000000000000000000000000ff00ff000000", "hex");
const png = await convertBmpToPngWithWorker(bmp);
const metadata = await createImageProcessor().probe(png);
assert.equal(metadata.width, 2);
assert.equal(metadata.height, 1);
assert.equal(metadata.format, "png");
console.log("relocated computer observations and image operations passed");
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
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            HOME: root,
            USERPROFILE: root,
            TMPDIR: root,
            TMP: root,
            TEMP: root,
          },
        },
      );
      expect(result.stdout).toContain(
        "relocated computer observations and image operations passed",
      );
    });

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
assert.match(highlight("const answer = 42;", {
  language: "javascript", theme: { keyword: text => "[" + text + "]" },
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
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            HOME: root,
            USERPROFILE: root,
            TMPDIR: root,
            TMP: root,
            TEMP: root,
          },
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
        const result = await promisify(execFile)(
          process.execPath,
          [
            ...(process.versions.bun ? ["--no-install"] : []),
            "--input-type=module",
            "--eval",
            probe,
            path.join(relocated, "worker/worker.mjs"),
            `ws://127.0.0.1:${address.port}`,
          ],
          {
            cwd: relocated,
            timeout: 30_000,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
              HOME: root,
              USERPROFILE: root,
              TMPDIR: root,
              TMP: root,
              TEMP: root,
            },
          },
        );
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

    const root = tempDirs.make("openclaw-worker-browser-composition-");
    const outputPath = path.join(root, "src/worker/browser.mjs");
    const runtimePath = path.join(root, "extensions/browser/runtime-api.js");
    const eventsPath = path.join(root, "events.txt");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(outputPath, transformed!);
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
      agentSessionKey: "worker:session-1",
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

  it("binds the lazy Playwright accessor to bundled modules", () => {
    const runtimePath = path.resolve("extensions/browser/src/browser/playwright-core.runtime.ts");
    const source = fs.readFileSync(runtimePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, runtimePath);

    expect(transformed).toContain('import * as playwrightCore from "playwright-core";');
    expect(transformed).toContain('import { getUserAgent } from "playwright-core/lib/coreBundle";');
    expect(transformed).toContain("return playwrightCore;");
    expect(transformed).not.toContain("createRequire");
    expect(transformed).not.toContain('require("playwright-core")');
  });

  it("bundles the undici dispatcher dependency without a worker runtime require", () => {
    const dispatcherPath = path.resolve("src/infra/net/undici-dispatcher-options.ts");
    const source = fs.readFileSync(dispatcherPath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, dispatcherPath);

    expect(transformed).toContain('import * as bundledUndici from "undici/index.js";');
    expect(transformed).toContain("return bundledUndici;");
    expect(transformed).toContain('return override as typeof import("undici");');
    expect(transformed).not.toContain('import { createRequire } from "node:module";');
    expect(transformed).not.toContain("const requireUndici = createRequire(import.meta.url);");
    expect(transformed).not.toContain('requireUndici("undici/index.js")');
    expect(transformed).not.toContain("undiciModule");
  });

  it("leaves fs-safe native package resolution to the dependency", () => {
    const nativePath = path.resolve("node_modules/@openclaw/fs-safe/dist/native.js");
    const source = fs.readFileSync(nativePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, nativePath);

    expect(transformed).toBeNull();
  });

  it("fails closed when the undici dispatcher bootstrap shape changes", () => {
    const dispatcherPath = path.resolve("src/infra/net/undici-dispatcher-options.ts");
    const source = fs.readFileSync(dispatcherPath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    expect(() =>
      plugin.transform.call(
        { error: fail },
        source.replace('requireUndici("undici/index.js")', 'changedUndici("undici/index.js")'),
        dispatcherPath,
      ),
    ).toThrow("undici dispatcher bootstrap changed");
  });

  it("inlines Playwright package identity without a runtime manifest read", () => {
    const coreBundlePath = path.resolve("node_modules/playwright-core/lib/coreBundle.js");
    const source = fs.readFileSync(coreBundlePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, coreBundlePath);

    expect(transformed).toContain('packageJSON = {"name":"playwright-core","version":"1.63.0"};');
    expect(transformed).not.toContain(
      'packageJSON = require(import_path9.default.join(packageRoot, "package.json"));',
    );
    expect(transformed).toContain(
      'registry = new Registry({"comment":"Do not edit this file, use utils/roll_browser.js"',
    );
    expect(transformed).not.toContain(
      'registry = new Registry(require(import_path20.default.join(packageRoot, "browsers.json")));',
    );
  });

  it("matches the canonical dependency path behind a pnpm-style symlink", () => {
    const sourceRoot = path.resolve("node_modules/playwright-core");
    const source = fs.readFileSync(path.join(sourceRoot, "lib/coreBundle.js"), "utf8");
    const tempRoot = tempDirs.make("openclaw-worker-build-plugin-");
    fs.mkdirSync(path.join(tempRoot, "node_modules"));
    for (const name of [
      "playwright-core",
      "web-tree-sitter",
      "tree-sitter-bash",
      "@silvia-odwyer/photon-node",
    ]) {
      fs.mkdirSync(path.join(tempRoot, "node_modules", path.dirname(name)), { recursive: true });
      fs.symlinkSync(
        path.resolve("node_modules", name),
        path.join(tempRoot, "node_modules", name),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const plugin = createWorkerDeployBuildPlugin(tempRoot);
    const resolvedId = fs.realpathSync(
      path.join(tempRoot, "node_modules/playwright-core/lib/coreBundle.js"),
    );

    const transformed = plugin.transform.call({ error: fail }, source, resolvedId);

    expect(transformed).toContain('packageJSON = {"name":"playwright-core","version":"1.63.0"};');
  });

  it("fails closed when the dependency-owned bootstrap shape changes", () => {
    const coreBundlePath = path.resolve("node_modules/playwright-core/lib/coreBundle.js");
    const plugin = createWorkerDeployBuildPlugin();

    expect(() =>
      plugin.transform.call({ error: fail }, "changed upstream source", coreBundlePath),
    ).toThrow("playwright-core package bootstrap changed");
  });
});
