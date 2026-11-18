import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStandaloneSourceDeclarations } from "../../scripts/lib/bun-standalone-source-declarations.mjs";
import { collectNativeTypeScriptDiagnostics } from "../../scripts/lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("standalone source declaration projections", () => {
  it("retains worker and ws contracts after redirecting imports to runtime aliases", () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../..");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-source-declarations-"));
    temporary.push(root);
    fs.symlinkSync(path.join(sourceRoot, "node_modules"), path.join(root, "node_modules"), "dir");
    const workerThreadsShim = path.join(root, "worker.cjs");
    const ws = path.join(root, "ws", "index.js");
    fs.mkdirSync(path.dirname(ws));
    fs.writeFileSync(path.join(root, "ws", "package.json"), '{"type":"commonjs"}');
    fs.writeFileSync(
      workerThreadsShim,
      'const native = require("node:worker_threads"); class Worker extends native.Worker {} module.exports = { ...native, Worker };',
    );
    fs.writeFileSync(ws, 'module.exports = require("ws");');
    writeStandaloneSourceDeclarations({ sourceRoot, moduleAliases: { ws }, workerThreadsShim });
    using session = createNativeTypeScriptProject({
      cwd: root,
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
            skipLibCheck: false,
          },
          files: ["consumer.ts"],
        }),
        "consumer.ts": `import { Worker, MessagePort, type Transferable, type WorkerOptions } from "./worker.cjs";
import WebSocket, { WebSocketServer, type ServerOptions, type ClientOptions, type RawData } from "./ws/index.js";
const compatible: typeof import("ws").WebSocket = WebSocket;
const CompatibleServer: typeof import("ws").WebSocketServer = WebSocketServer;
export function server(options: ServerOptions): import("ws").WebSocketServer { return new CompatibleServer(options); }
export function stop(worker: Worker, port: MessagePort): void {
  worker.unref();
  port.unref();
  // @ts-expect-error Runtime aliases retain the worker method contract.
  worker.missingMethod();
}
export function options(transferList: Transferable[]): WorkerOptions { return { transferList }; }
export function connect(url: string, options: ClientOptions): WebSocket {
  return new compatible(url, { ...options, maxPayload: 1024 });
}
export function length(data: RawData): number { return Array.isArray(data) ? data.length : data.byteLength; }
// @ts-expect-error Published ws types still reject a wrong maxPayload type.
const invalidOptions: ClientOptions = { maxPayload: "many" };
`,
      },
    });
    expect(collectNativeTypeScriptDiagnostics(session.project)).toEqual([]);
  });
});
