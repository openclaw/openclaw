import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createClawdbotTools } from "../agents/clawdbot-tools.js";
import { resolveSessionTranscriptPath } from "../config/sessions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("sessions_send gateway loopback", () => {
  it("returns reply when lifecycle ends before agent.wait", async () => {
    const port = await getFreePort();
    const prevPort = process.env.CLAWDBOT_GATEWAY_PORT;
    process.env.CLAWDBOT_GATEWAY_PORT = String(port);

    const server = await startGatewayServer(port);
    const spy = vi.mocked(agentCommand);
    spy.mockImplementation(async (opts) => {
      const params = opts as {
        sessionId?: string;
        runId?: string;
        extraSystemPrompt?: string;
      };
      const sessionId = params.sessionId ?? "main";
      const runId = params.runId ?? sessionId;
      const sessionFile = resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });

      const startedAt = Date.now();
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt },
      });

      let text = "pong";
      if (params.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
        text = "REPLY_SKIP";
      } else if (
        params.extraSystemPrompt?.includes("Agent-to-agent announce step")
      ) {
        text = "ANNOUNCE_SKIP";
      }
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      };
      await fs.appendFile(
        sessionFile,
        `${JSON.stringify({ message })}\n`,
        "utf8",
      );

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
        },
      });
    });

    try {
      const tool = createClawdbotTools().find(
        (candidate) => candidate.name === "sessions_send",
      );
      if (!tool) throw new Error("missing sessions_send tool");

      const result = await tool.execute("call-loopback", {
        sessionKey: "main",
        message: "ping",
        timeoutSeconds: 5,
      });
      const details = result.details as {
        status?: string;
        reply?: string;
        sessionKey?: string;
      };
      expect(details.status).toBe("ok");
      expect(details.reply).toBe("pong");
      expect(details.sessionKey).toBe("main");

      const firstCall = spy.mock.calls[0]?.[0] as { lane?: string } | undefined;
      expect(firstCall?.lane).toBe("nested");
    } finally {
      if (prevPort === undefined) {
        delete process.env.CLAWDBOT_GATEWAY_PORT;
      } else {
        process.env.CLAWDBOT_GATEWAY_PORT = prevPort;
      }
      await server.close();
    }
  });
});
