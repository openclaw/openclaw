import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteStandaloneImports } from "../../scripts/lib/bun-standalone-imports.mjs";
import { createStandaloneSourceGlobals } from "../../scripts/lib/bun-standalone-source-globals.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";
import { createStandaloneSourceTransforms } from "../../scripts/lib/bun-standalone-source-transforms.mjs";
import { collectNativeTypeScriptDiagnostics } from "../../scripts/lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";
import { createWorkerDeployBuildPlugin } from "../../scripts/lib/worker-deploy-build-plugin.mts";

describe("standalone worker source types", () => {
  it("preserves the Knowledge worker SDK resolver after image namespace rewriting", () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const filename = path.join(sourceRoot, "extensions/knowledge/src/worker-sdk-resolver.ts");
    const transformed = rewriteStandaloneImports({
      contents: fs.readFileSync(filename, "utf8"),
      filename,
      runtimeRoot: sourceRoot,
      embeddedPaths: {},
      moduleAliases: {},
      workerThreadsShim: "",
      parse: createStandaloneSourceParser(),
      preserveTypes: true,
    });
    using session = createNativeTypeScriptProject({
      cwd: sourceRoot,
      configFileName: "tsconfig.json",
      files: {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: "nodenext",
            target: "esnext",
            types: ["node"],
            skipLibCheck: true,
          },
          files: ["worker.ts", "globals.d.ts", "consumer.ts"],
        }),
        "package.json": '{"type":"module"}',
        "worker.ts": transformed,
        "globals.d.ts": createStandaloneSourceGlobals(),
        "consumer.ts": `import {installWorkerSdkResolver} from "./worker.js"; installWorkerSdkResolver({"openclaw/plugin-sdk/example": "file:///runtime/example.js"});`,
      },
    });
    expect(collectNativeTypeScriptDiagnostics(session.project)).toEqual([]);
  });

  it("retains the Gateway transport types through the portable worker transform", async () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-worker-types-"));
    try {
      const filename = path.join(sourceRoot, "packages/gateway-client/src/websocket.ts");
      const transforms = createStandaloneSourceTransforms({
        sourceRoot,
        runtimeRoot,
        parse: createStandaloneSourceParser(),
      });
      const transformed = await transforms.transform({
        filename,
        contents: fs.readFileSync(filename, "utf8"),
        config: { plugins: [createWorkerDeployBuildPlugin(sourceRoot)] },
      });
      fs.symlinkSync(
        path.join(sourceRoot, "node_modules"),
        path.join(runtimeRoot, "node_modules"),
        "dir",
      );
      using session = createNativeTypeScriptProject({
        cwd: runtimeRoot,
        configFileName: "tsconfig.json",
        files: {
          "package.json": '{"type":"module"}',
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              module: "nodenext",
              target: "esnext",
              lib: ["ES2023"],
              types: ["node"],
              skipLibCheck: true,
            },
            files: ["consumer.ts"],
          }),
          "websocket.ts": transformed.contents,
          "consumer.ts": `import { WebSocket, WebSocketServer, type GatewayWebSocketTargetOptions, type GatewayWebSocketClientOptions, type ClientOptions, type RawData } from "./websocket.js";
const target: GatewayWebSocketTargetOptions = { url: "wss://example.invalid", tlsServerName: "example.invalid" };
const options: GatewayWebSocketClientOptions = { servername: "example.invalid", maxPayload: 1024 };
const wsOptions: ClientOptions = { maxPayload: options.maxPayload };
type Client = GatewayWebSocketTargetOptions & { caps?: string[] };
const call: Pick<Client, "caps"> & { method: string } = { method: "health" };
const compatible: typeof import("ws").WebSocketServer = WebSocketServer;
export function size(data: RawData): number { return Array.isArray(data) ? data.length : data.byteLength; }
export function inspect() { return [target.tlsServerName, wsOptions.maxPayload, call.method, WebSocket.prototype.ping, compatible.prototype.handleUpgrade]; }
// @ts-expect-error The worker transform must preserve the target's string contract.
const invalidTarget: GatewayWebSocketTargetOptions = { tlsServerName: 42 };
`,
        },
      });
      expect(collectNativeTypeScriptDiagnostics(session.project)).toEqual([]);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("retains Playwright loader types when its CommonJS modules are source project roots", async () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-playwright-types-"));
    try {
      const filename = path.join(
        sourceRoot,
        "extensions/browser/src/browser/playwright-core.runtime.ts",
      );
      const playwrightRoot = fs.realpathSync(path.join(sourceRoot, "node_modules/playwright-core"));
      const transforms = createStandaloneSourceTransforms({
        sourceRoot,
        runtimeRoot,
        parse: createStandaloneSourceParser(),
      });
      const transformed = await transforms.transform({
        filename,
        contents: fs.readFileSync(filename, "utf8"),
        config: { plugins: [createWorkerDeployBuildPlugin(sourceRoot)] },
      });
      fs.symlinkSync(
        path.join(sourceRoot, "node_modules"),
        path.join(runtimeRoot, "node_modules"),
        "dir",
      );
      using session = createNativeTypeScriptProject({
        cwd: runtimeRoot,
        configFileName: "tsconfig.json",
        files: {
          "package.json": '{"type":"module"}',
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              allowJs: true,
              strict: true,
              noEmit: true,
              module: "nodenext",
              target: "esnext",
              lib: ["ES2023"],
              types: ["node"],
              skipLibCheck: true,
            },
            files: [
              "consumer.ts",
              path.join(playwrightRoot, "index.js"),
              path.join(playwrightRoot, "lib/coreBundle.js"),
            ],
            include: [],
          }),
          "playwright.ts": transformed.contents,
          "consumer.ts": `import { getPlaywrightCore, getPlaywrightUserAgent } from "./playwright.js";
const core: typeof import("playwright-core") = getPlaywrightCore();
const browser: Promise<import("playwright-core").Browser> = core.chromium.connectOverCDP("http://example.invalid");
const userAgent: string = getPlaywrightUserAgent();
// @ts-expect-error The loader must retain Playwright's connection argument type.
getPlaywrightCore().chromium.connectOverCDP(42);
// @ts-expect-error The loader's User-Agent remains a string.
const invalidUserAgent: number = getPlaywrightUserAgent();
void [browser, userAgent, invalidUserAgent];
`,
        },
      });
      expect(collectNativeTypeScriptDiagnostics(session.project)).toEqual([]);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("retains contextual parameters when composing the Browser runtime", async () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-browser-types-"));
    try {
      const filename = path.join(sourceRoot, "src/worker/worker-deploy-browser-runtime.ts");
      const transforms = createStandaloneSourceTransforms({
        sourceRoot,
        runtimeRoot,
        parse: createStandaloneSourceParser(),
      });
      const transformed = await transforms.transform({
        filename,
        contents: fs.readFileSync(filename, "utf8"),
        config: { plugins: [createWorkerDeployBuildPlugin(sourceRoot)] },
      });
      fs.symlinkSync(
        path.join(sourceRoot, "node_modules"),
        path.join(runtimeRoot, "node_modules"),
        "dir",
      );
      using session = createNativeTypeScriptProject({
        cwd: runtimeRoot,
        configFileName: "tsconfig.json",
        files: {
          "package.json": '{"type":"module"}',
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              module: "nodenext",
              target: "esnext",
              lib: ["ES2023"],
              types: ["node"],
              skipLibCheck: true,
            },
            files: ["consumer.ts"],
          }),
          "src/worker/worker-deploy-browser-runtime.ts": transformed.contents,
          "src/worker/browser-runtime.ts": `export type WorkerBrowserRuntime = {
  createAttachedBrowserToolRuntime: (params: { cdpUrl: string }) => Promise<string>;
};`,
          "extensions/browser/runtime-api.ts": `export async function createAttachedBrowserToolRuntime(params: { cdpUrl: string }): Promise<string> { return params.cdpUrl; }`,
          "consumer.ts": `import runtime from "./src/worker/worker-deploy-browser-runtime.js";
export const result: Promise<string> = runtime.createAttachedBrowserToolRuntime({ cdpUrl: "http://example.invalid" });
// @ts-expect-error The source-owned method type must survive runtime composition.
void runtime.createAttachedBrowserToolRuntime({ cdpUrl: 42 });
`,
        },
      });
      expect(collectNativeTypeScriptDiagnostics(session.project)).toEqual([]);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("typechecks the facade activation loader after replacing the host implementation", async () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-facade-types-"));
    try {
      const filename = path.join(sourceRoot, "src/plugin-sdk/facade-runtime.ts");
      const source = fs.readFileSync(filename, "utf8");
      const parse = createStandaloneSourceParser();
      // Check the real loader declarations without importing the unrelated plugin registry graph.
      const contents = parse(source, { sourceType: "module" })
        .body.filter(
          (node) =>
            (node.type === "FunctionDeclaration" || node.type === "TSTypeAliasDeclaration") &&
            node.id?.name.includes("FacadeActivationCheckRuntime"),
        )
        .map((node) => source.slice(node.start ?? 0, node.end ?? 0))
        .join("\n");
      const transforms = createStandaloneSourceTransforms({ sourceRoot, runtimeRoot, parse });
      const transformed = await transforms.transform({
        filename,
        contents,
        config: { plugins: [createWorkerDeployBuildPlugin(sourceRoot)] },
      });
      fs.symlinkSync(
        path.join(sourceRoot, "node_modules"),
        path.join(runtimeRoot, "node_modules"),
        "dir",
      );
      using session = createNativeTypeScriptProject({
        cwd: runtimeRoot,
        configFileName: "tsconfig.json",
        files: {
          "package.json": '{"type":"module"}',
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              module: "nodenext",
              target: "esnext",
              types: ["node"],
              skipLibCheck: true,
            },
            files: ["facade-runtime.ts"],
          }),
          "facade-runtime.ts": `import { fileURLToPath } from "node:url";
declare const CURRENT_MODULE_PATH: string;
declare function getPluginCacheSource(key: string): {
  variants: Map<string, { exports?: { value: unknown } }>;
};
declare function isPluginSourceModulePath(modulePath: string): boolean;
declare function tryNativeRequireModule(modulePath: string):
  { ok: true; moduleExport: unknown } | { ok: false };
declare function require(request: string): typeof import("./facade-activation-check.runtime.js");
${transformed.contents}
export { loadFacadeActivationCheckRuntime, loadFacadeActivationCheckRuntimeAsync };
`,
          "facade-activation-check.runtime.ts": 'export const marker = "activated";',
        },
      });
      expect(collectNativeTypeScriptDiagnostics(session.project)).toEqual([]);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
