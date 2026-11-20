import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import type { RequestFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { startRuntimePty } from "./tui-pty-test-support.js";

// Exercise the CLI, remote backend, renderer and real logging sinks with fixed Gateway replies.
it("keeps subsystem warnings off a remote terminal while retaining file logs and restoring console output", async () => {
  await withTempDir("openclaw-tui-console-", async (dir) => {
    const server = await reserveTestPortListener({ offsets: [0], createListener: createServer });
    const gateway = new WebSocketServer({ server: server.listener });
    onTestFinished(async () => {
      for (const socket of gateway.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        gateway.close(() => resolve());
      });
      await server.releaseListener();
      await server.claim.release();
    });
    gateway.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "fixture", ts: Date.now() },
        }),
      );
      socket.on("message", (raw) => {
        const req = JSON.parse(rawDataToString(raw)) as RequestFrame;
        const replies: Record<string, unknown> = {
          connect: {
            type: "hello-ok",
            protocol: 3,
            features: { methods: [], events: [] },
            policy: { tickIntervalMs: 60_000 },
          },
          "agents.list": { defaultId: "main", agents: [{ id: "main" }] },
          "sessions.list": { sessions: [], defaults: {} },
          "sessions.describe": { session: null },
          "models.list": { models: [] },
          "commands.list": { commands: [] },
          "questions.list": { questions: [] },
          "task_suggestions.list": { suggestions: [] },
          "chat.history": { messages: [] },
        };
        socket.send(
          JSON.stringify({ type: "res", id: req.id, ok: true, payload: replies[req.method] ?? {} }),
        );
      });
    });
    const moduleUrl = (name: string) =>
      resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: name,
        distWorkerPath: `${name.replace(/^\.\.\//, "")}.js`,
      });
    const cli = moduleUrl("../cli/tui-cli");
    const logPath = path.join(dir, "subsystem.log");
    const configPath = path.join(dir, "openclaw.json");
    await writeFile(
      configPath,
      JSON.stringify({
        logging: { level: "warn", consoleLevel: "warn", file: logPath },
      }),
    );
    const script = `
      import { Command } from "commander";
      import { registerTuiCli } from ${JSON.stringify(cli.href)};
      import { createSubsystemLogger } from ${JSON.stringify(moduleUrl("../logging/subsystem").href)};
      const log = createSubsystemLogger("console-regression");
      process.stdin.on("data", (data) => {
        if (String(data).includes("\\x1b[24~")) log.warn("ACTIVE_SUBSYSTEM_WARNING");
      });
      const program = new Command();
      registerTuiCli(program);
      await program.parseAsync(["tui", "--url", ${JSON.stringify(`ws://127.0.0.1:${server.claim.port}`)}, "--token", "fixture", "--session", "agent:main:console-proof"], { from: "user" });
      log.warn("RESTORED_SUBSYSTEM_WARNING");
    `;
    const run = await startRuntimePty(
      process.execPath,
      [...resolveRuntimeWorkerArgv(cli).slice(0, -1), "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: {
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_HOME: dir,
          OPENCLAW_LOG_LEVEL: "warn",
          PI_PROGRAM_STATUS: "0",
        },
        exitTimeoutMs: 4_000,
        outputTimeoutMs: 2_000,
      },
    );
    try {
      await run.waitForOutput("gateway connected", 20_000);
      await run.write("\x1b[24~", { delay: false });
      await run.write("/exit\r", { delay: false });
      expect((await run.waitForExit()).exitCode).toBe(0);
      expect(await readFile(logPath, "utf8")).toContain("ACTIVE_SUBSYSTEM_WARNING");
      expect(run.visibleOutput()).toContain("RESTORED_SUBSYSTEM_WARNING");
      expect(run.visibleOutput()).not.toContain("ACTIVE_SUBSYSTEM_WARNING");
    } finally {
      await run.dispose();
    }
  });
}, 30_000);
