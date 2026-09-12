// Fresh native admission and configured agent entry; local synthetic Gateway, no live installation.
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildMinimalGatewayHelloOkPayload,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const source = (file: string) => pathToFileURL(path.resolve(file)).href;
it.each(["repair", "no-effect", "already-healthy", "preserve"])(
  "joins real current-main startup %s and returns independent original-parent result",
  async (mode) => {
    const root = await fs.realpath(dirs.make("startup-native-"));
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No fixture port");
    }
    const port = address.port;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => {
      sendMinimalGatewayConnectChallenge(socket);
      socket.on("message", (data) => {
        const request = parseMinimalGatewayRequestFrame(data);
        if (request.type !== "req" || !request.id) {
          return;
        }
        if (request.method === "connect") {
          const hello = buildMinimalGatewayHelloOkPayload({
            auth: { role: "operator", scopes: ["operator.read"] },
          });
          sendMinimalGatewayResponse(socket, request.id, {
            ...hello,
            server: {
              ...hello.server,
              version: "2026.9.11",
              bootId: "native-repair-boot",
              buildId: "fixture-build",
            },
          });
        } else {
          sendMinimalGatewayResponse(socket, request.id, { ok: true });
        }
      });
    });
    const startGateway = async () => {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
    };
    if (mode === "already-healthy") {
      await startGateway();
    }
    await fs.mkdir(path.join(root, "dist"));
    const profile = path.join(root, "profile");
    await fs.mkdir(profile);
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module", version: "2026.9.11" }),
    );
    await fs.writeFile(
      path.join(profile, "openclaw.json"),
      JSON.stringify({
        gateway: { port, auth: { mode: "none" } },
        agents: { defaults: { model: "fixture/model" } },
      }),
    );
    const effectCode = 'require("node:fs").writeFileSync(process.argv[1],"actual-child-effect")';
    const agentCode = `
import {execFileSync} from "node:child_process";
import fs from "node:fs/promises";
import {watch,existsSync} from "node:fs";
import path from "node:path";
import {once} from "node:events";
const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)};
export async function agentExecCommand(prompt,options,runtime,deps){
 deps.assertSourceCurrent();
 await fs.writeFile(path.join(root,"agent-input.json"),JSON.stringify({prompt,cwd:options.cwd}));
 if(mode!=="no-effect" && mode!=="preserve"){
  const changes=watch(root);
  try{
   execFileSync(process.execPath,["-e",${JSON.stringify(effectCode)},path.join(root,"effect")]);
   while(!existsSync(path.join(root,"listening")))await once(changes,"change");
  }finally{changes.close();}
 }
 deps.assertSourceCurrent();
 return {exitCode:0};
}
`;
    const childCode = `
import {registerHooks} from "node:module";
registerHooks({load(url,context,next){
 if(url.endsWith('/doctor-lint.ts')||url.endsWith('/doctor-lint.js'))return {format:'module',shortCircuit:true,source:'export const collectDoctorFindings=async()=>[];'};
 if(url.endsWith('/agent-exec.ts')||url.endsWith('/agent-exec.js'))return {format:'module',shortCircuit:true,source:${JSON.stringify(agentCode)}};
 return next(url,context);
}});
const {triageCommand}=await import(${JSON.stringify(source("src/commands/triage.ts"))});
const {defaultRuntime}=await import(${JSON.stringify(source("src/runtime.ts"))});
await triageCommand(defaultRuntime,{noExport:true});
`;
    await fs.writeFile(path.join(root, "dist/index.js"), childCode);
    const parent = path.join(root, "parent.mjs");
    await fs.writeFile(
      parent,
      `
import {triageAfterFailure} from ${JSON.stringify(source("src/commands/triage-failure.ts"))};
const report=await triageAfterFailure({log:console.log,error:console.error,exit:code=>{throw new Error('unexpected parent exit '+code)}},{kind:'gateway-startup',phase:'startup',error:'original startup failure',installationRoot:${JSON.stringify(root)},expectedVersion:'2026.9.11',gateway:${JSON.stringify(mode === "preserve" ? "preserve" : "verify-running")}});
const {reloadTaskRegistryFromStore,listTaskRecords}=await import(${JSON.stringify(source("src/tasks/task-registry.ts"))});
reloadTaskRegistryFromStore();
const tasks=listTaskRecords().map(({taskId,status,terminalSummary})=>({taskId,status,terminalSummary}));
process.stdout.write(JSON.stringify({report,tasks})+'\\n');
`,
    );
    const running = promisify(execFile)(
      process.execPath,
      ["--import", path.resolve("scripts/tsx.mjs"), parent],
      {
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          OPENCLAW_TEST_RUNTIME_LOG: "1",
          OPENCLAW_STATE_DIR: profile,
          OPENCLAW_CONFIG_PATH: path.join(profile, "openclaw.json"),
          OPENCLAW_GATEWAY_PORT: String(port),
          OPENCLAW_WORKSPACE_DIR: root,
          OPENCLAW_SHELL: "",
          CODEX_THREAD_ID: "",
          OPENCLAW_SUPERVISOR_MODE: "",
          OPENCLAW_SERVICE_MARKER: "",
          OPENCLAW_UPDATE_RUN_HANDOFF: "",
          NODE_OPTIONS: `--import ${path.resolve("scripts/tsx.mjs")}`,
        },
      },
    );
    try {
      if (mode === "repair") {
        await Promise.race([
          vi.waitFor(
            async () =>
              expect(await fs.readFile(path.join(root, "effect"), "utf8")).toBe(
                "actual-child-effect",
              ),
            { timeout: 60000 },
          ),
          running.then((result) => {
            throw new Error(`parent ended before effect: ${result.stderr}`);
          }),
        ]);
        await startGateway();
        await fs.writeFile(path.join(root, "listening"), "ready");
      }
      const output = await running;
      const parsed = JSON.parse(output.stdout);
      if (mode === "preserve") {
        expect(parsed.report).toBeUndefined();
        expect(parsed.tasks).toEqual([]);
        const input = JSON.parse(await fs.readFile(path.join(root, "agent-input.json"), "utf8"));
        expect(input.prompt).toContain("original startup failure");
        expect(input.cwd).toBe(root);
        expect(server.listening).toBe(false);
        return;
      }
      expect(parsed.report, output.stderr).toMatchObject({
        kind: "startup-repair",
        installationRoot: root,
        attempted: mode !== "already-healthy",
        after: { ok: mode !== "no-effect", port },
      });
      expect(parsed.report.generationOwner).toBeTruthy();
      if (mode === "already-healthy") {
        expect(parsed.tasks).toEqual([]);
      } else {
        expect(parsed.tasks).toHaveLength(1);
        expect(parsed.tasks[0]).toMatchObject({
          taskId: parsed.report.repairTaskId,
          status: mode === "repair" ? "succeeded" : "failed",
        });
      }
      if (mode === "already-healthy") {
        await expect(fs.stat(path.join(root, "agent-input.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        const input = JSON.parse(await fs.readFile(path.join(root, "agent-input.json"), "utf8"));
        expect(input.cwd).toBe(root);
        expect(input.prompt).toContain("original startup failure");
        expect(parsed.report.agentExitCode).toBe(0);
      }
    } finally {
      await fs.writeFile(path.join(root, "listening"), "test-drain");
      await running.catch(() => undefined);
      for (const client of sockets.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => resolve());
      });
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }
  },
);
