import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { waitForExecScope } from "../agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import { createProcessTool } from "../agents/bash-tools.process.js";
import { acknowledgeInternalToolResult } from "../agents/runtime/internal-hooks.js";
import { withFastReplyConfig } from "../auto-reply/reply/get-reply-fast-path.test-support.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { buildMockOpenAiResponsesProvider } from "../gateway/test-openai-responses-model.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { runHeartbeatOnce, setHeartbeatsEnabled } from "./heartbeat-runner.js";
import { withTempHeartbeatSandbox, seedMainSessionStore } from "./heartbeat-runner.test-utils.js";
import * as targets from "./outbound/targets.js";
import { peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

afterEach(() => {
  resetProcessRegistryForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
  setHeartbeatsEnabled(true);
});

describe("heartbeat preparation acknowledgement through real agent dispatch", () => {
  it.each([true, false])(
    "acknowledged during preparation: %s",
    async (acknowledged) => {
      const bodies: string[] = [];
      const port = await acquireTestPortBlock({ offsets: [0] });
      const server = createServer((request, response) => {
        void (async () => {
          let body = "";
          for await (const chunk of request) {
            body += String(chunk);
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          bodies.push(body);
          const message = {
            type: "message",
            id: "heartbeat-proof-message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "HEARTBEAT_OK", annotations: [] }],
          };
          writeOpenAiResponsesSse(response, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", output_index: 0, item: message },
            {
              type: "response.completed",
              response: {
                id: "heartbeat-proof-response",
                status: "completed",
                output: [message],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              },
            },
          ]);
        })().catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port.port, "127.0.0.1", resolve);
        });
        await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
          vi.stubEnv("OPENCLAW_AGENT_RUNTIME", "openclaw");
          vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
          vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
          const provider = buildMockOpenAiResponsesProvider(
            `http://127.0.0.1:${port.port}/v1`,
            "heartbeat-proof",
          );
          const cfg = withFastReplyConfig({
            agents: {
              entries: { main: { default: true } },
              defaults: {
                workspace: tmpDir,
                skipBootstrap: true,
                heartbeat: { every: "5m", target: "none" },
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
              },
            },
            models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
            plugins: { slots: { memory: "none" } },
            session: { store: storePath },
            tools: { profile: "minimal" },
          });
          const sessionKey = await seedMainSessionStore(storePath, cfg, {
            lastChannel: "webchat",
            lastProvider: "webchat",
            lastTo: "heartbeat-proof",
          });
          const quote = (value: string) =>
            `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
          const releasePath = path.join(tmpDir, "release-child");
          const source = `const fs = require("node:fs");
            let done = false;
            const release = () => {
              if (!done && fs.existsSync(${JSON.stringify(releasePath)})) {
                done = true; watcher.close(); process.stdout.write("SYNTHETIC_COMPLETION");
              }
            };
            const watcher = fs.watch(${JSON.stringify(tmpDir)}, release);
            release();`;

          const invocation = `${quote(process.execPath)} -e ${quote(source)}`;
          const command = process.platform === "win32" ? `& ${invocation}` : invocation;
          const exec = createExecTool({
            config: cfg,
            host: "gateway",
            security: "full",
            ask: "off",
            allowBackground: true,
            notifyOnExit: true,
            notifySessionKey: sessionKey,
            sessionKey,
            agentId: "main",
            scopeKey: sessionKey,
            timeoutSec: 30,
            cwd: tmpDir,
          });
          const processTool = createProcessTool({ scopeKey: sessionKey });
          const started = await exec.execute("proof-exec", { command, background: true });
          expect(started.details.status).toBe("running");
          if (started.details.status !== "running") {
            throw new Error("Expected background handle");
          }
          const processSessionId = started.details.sessionId;
          await fs.writeFile(releasePath, "release");
          await waitForExecScope(sessionKey);
          expect(peekSystemEvents(sessionKey).join("\n")).toContain("SYNTHETIC_COMPLETION");
          const resolveTarget = targets.resolveHeartbeatDeliveryTargetWithSessionRoute;
          let prepared = false;
          vi.spyOn(
            targets,
            "resolveHeartbeatDeliveryTargetWithSessionRoute",
          ).mockImplementationOnce(async (...args) => {
            const route = await resolveTarget(...args);
            prepared = true;
            if (acknowledged) {
              const result = await processTool.execute("proof-poll", {
                action: "poll",
                sessionId: processSessionId,
              });
              expect(result.details).toMatchObject({
                status: "completed",
                aggregated: "SYNTHETIC_COMPLETION",
              });
              acknowledgeInternalToolResult(result);
              expect(peekSystemEvents(sessionKey)).toEqual([]);
            }
            return route;
          });
          const result = await runHeartbeatOnce({
            cfg,
            agentId: "main",
            source: "exec-event",
            intent: "event",
            reason: "exec-event",
          });
          const session = loadExactSessionEntryReadOnly({ agentId: "main", storePath, sessionKey });
          const messages = session?.entry
            ? await readSessionMessagesAsync(
                {
                  storePath,
                  sessionEntry: session.entry,
                  sessionId: session.entry.sessionId,
                  sessionKey,
                },
                { mode: "full", reason: "synthetic heartbeat race proof" },
              )
            : [];
          const assistantTurns = messages.filter(
            (message: unknown) =>
              typeof message === "object" &&
              message !== null &&
              "role" in message &&
              message.role === "assistant",
          );
          expect(assistantTurns).toHaveLength(acknowledged ? 0 : 1);
          expect(prepared).toBe(true);
          expect(bodies).toHaveLength(acknowledged ? 0 : 1);
          if (acknowledged) {
            expect(result).toMatchObject({ status: "skipped", reason: "no-pending-event" });
          } else {
            expect(result.status).toBe("ran");
            expect(bodies[0]).toContain("An async command completion event was triggered");
          }
          expect(peekSystemEvents(sessionKey)).toEqual([]);
        });
      } finally {
        server.closeAllConnections();
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        } finally {
          await port.release();
        }
      }
    },
    120_000,
  );
});
