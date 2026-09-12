import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { mergeWorkspaceSetupState } from "../agents/workspace-state-store.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "../gateway/gateway-cli-backend.live-helpers.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "../gateway/session-utils.js";
import { extractPayloadText } from "../gateway/test-helpers.agent-results.js";
import { listKnownProviderAuthEnvVarNames } from "../secrets/provider-env-vars.js";

const enabled = isLiveTestEnabled() && process.env.OPENCLAW_LIVE_SESSION_EVENT_WAKE === "1";
const describeLive = enabled ? describe : describe.skip;
const TURN_TIMEOUT_MS = 180_000;
const MODEL = "openai/gpt-5.6-sol";

async function readMessages(sessionKey: string): Promise<unknown[]> {
  const { storePath, entry } = loadGatewaySessionEntryReadOnly(sessionKey);
  if (!entry?.sessionId) {
    return [];
  }
  return readSessionMessagesAsync(
    { storePath, sessionEntry: entry, sessionId: entry.sessionId, sessionKey },
    { mode: "full", reason: "live completion and heartbeat routing verification" },
  );
}

function messagesWithRole(messages: unknown[], role: string): string {
  return JSON.stringify(messages.filter((message) => asOptionalRecord(message)?.role === role));
}

describeLive("session event wake through a live Gateway", () => {
  it("continues a completed foreground session for exec results and keeps monitor polls on main", async () => {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("OPENCLAW_LIVE_SESSION_EVENT_WAKE requires OPENAI_API_KEY");
    }
    const instance = await createOpenClawTestInstance({
      name: "live-session-event-wake",
      env: {
        ...Object.fromEntries(listKnownProviderAuthEnvVarNames().map((name) => [name, undefined])),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENCLAW_AGENT_RUNTIME: "openclaw",
        OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_SKIP_CRON: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      },
    });
    let client: GatewayClient | undefined;
    const sessionKey = `agent:main:live-completion-${randomUUID()}`;
    const mainSessionKey = "agent:main:main";
    const nonce = randomUUID();
    const startedReply = `STARTED-${nonce}`;
    const completionReply = `COMPLETION-${nonce}`;
    const monitorReply = `MAIN-MONITOR-${nonce}`;
    const workspace = instance.state.workspaceDir;
    const gatePath = path.join(workspace, "release-command");
    try {
      instance.state.applyEnv();
      await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
      await fs.rm(path.join(workspace, "BOOTSTRAP.md"), { force: true });
      await mergeWorkspaceSetupState(workspace, { setupCompletedAt: new Date().toISOString() });
      await fs.writeFile(
        path.join(workspace, "AGENTS.md"),
        "Follow exact reply instructions. This workspace contains only synthetic live-test data.\n",
      );
      // The external gate establishes foreground-final-before-process-exit ordering.
      await fs.writeFile(
        path.join(workspace, "completion-gate.cjs"),
        [
          'const fs = require("node:fs");',
          'fs.writeFileSync("command-started", "started");',
          "const deadline = Date.now() + 180000;",
          "const timer = setInterval(() => {",
          '  if (fs.existsSync("release-command")) {',
          "    clearInterval(timer);",
          `    console.log(${JSON.stringify(completionReply)});`,
          '    fs.writeFileSync("command-completed", "completed");',
          "  } else if (Date.now() > deadline) {",
          "    clearInterval(timer);",
          '    console.error("Live fixture gate was not released");',
          "    process.exitCode = 1;",
          "  }",
          "}, 50);",
        ].join("\n"),
      );
      const config: OpenClawConfig = {
        gateway: {
          mode: "local",
          port: instance.port,
          auth: { mode: "token", token: instance.gatewayToken },
          controlUi: { enabled: false },
        },
        plugins: { allow: ["openai"] },
        secrets: { providers: { default: { source: "env" } } },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            workspace,
            skipBootstrap: true,
            thinkingDefault: "low",
            timeoutSeconds: 170,
            model: { primary: MODEL },
            models: { [MODEL]: { agentRuntime: { id: "openclaw" } } },
            sandbox: { mode: "off" },
            heartbeat: {
              every: "24h",
              target: "none",
              prompt: `Call heartbeat_respond with outcome progress, notify false, summary ${monitorReply}. Do no other work.`,
            },
          },
        },
        tools: {
          codeMode: true,
          exec: { host: "gateway", mode: "full", notifyOnExit: true },
        },
      };
      await instance.state.writeConfig(config);
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
        displayName: "live-session-event-wake",
      });
      await instance.startGateway();
      client = await connectTestGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        deviceIdentity,
        requestTimeoutMs: TURN_TIMEOUT_MS,
      });
      const response = await client.request<{ status?: string; result?: unknown }>(
        "agent",
        {
          sessionKey,
          idempotencyKey: randomUUID(),
          deliver: false,
          timeout: 170,
          message: [
            "Start the existing completion-gate.cjs fixture using the shell exec tool, command node completion-gate.cjs, with background true and timeoutSeconds 180.",
            "Use Code Mode to invoke the shell exec tool. Do not read, modify, or run any other file. Do not poll or wait for the process.",
            `Once exec returns its running session, reply exactly ${startedReply} and end this turn.`,
            "Handle its later completion silently with NO_REPLY; this fixture disables notification delivery.",
          ].join("\n"),
        },
        { expectFinal: true, timeoutMs: TURN_TIMEOUT_MS },
      );
      expect(response.status).toBe("ok");
      expect(extractPayloadText(response.result)).toContain(startedReply);
      expect(await fs.readFile(path.join(workspace, "command-started"), "utf8")).toBe("started");
      const foregroundMessages = await readMessages(sessionKey);
      expect(messagesWithRole(foregroundMessages, "assistant")).not.toContain(completionReply);
      await expect(fs.access(path.join(workspace, "command-completed"))).rejects.toThrow();

      await fs.writeFile(gatePath, "release");
      await vi.waitFor(
        async () => {
          expect(instance.logs()).not.toContain("Async work scope is closed");
          const continued = (await readMessages(sessionKey)).slice(foregroundMessages.length);
          expect(continued).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "assistant",
                provider: "openai",
                stopReason: "stop",
                content: expect.arrayContaining([
                  expect.objectContaining({ type: "text", text: "NO_REPLY" }),
                ]),
              }),
            ]),
          );
        },
        { timeout: TURN_TIMEOUT_MS, interval: 1_000 },
      );
      const completedMessages = await readMessages(sessionKey);
      const completionUsers = messagesWithRole(
        completedMessages.slice(foregroundMessages.length),
        "user",
      );
      expect(completionUsers).toContain("[OpenClaw exec completion]");
      expect(completionUsers).not.toContain("[OpenClaw heartbeat poll]");
      expect(await fs.readFile(path.join(workspace, "command-completed"), "utf8")).toBe(
        "completed",
      );
      expect(await readMessages(mainSessionKey)).toEqual([]);

      const jobs = await client.request<{
        jobs: Array<{
          id: string;
          agentId?: string;
          payload: { kind: string };
          sessionTarget: string;
        }>;
      }>("cron.list", { includeDisabled: true });
      const monitor = jobs.jobs.find((job) => job.payload.kind === "heartbeat");
      expect(monitor).toMatchObject({ sessionTarget: "main" });
      if (!monitor) {
        throw new Error("Gateway did not create its main-session heartbeat monitor");
      }
      const forced = await client.request<{ ok: boolean }>("cron.run", {
        id: monitor.id,
        mode: "force",
      });
      expect(forced.ok).toBe(true);
      await vi.waitFor(
        async () => {
          const mainMessages = await readMessages(mainSessionKey);
          expect(messagesWithRole(mainMessages, "user")).toContain("[OpenClaw heartbeat poll]");
          expect(messagesWithRole(mainMessages, "assistant")).toContain(monitorReply);
        },
        { timeout: TURN_TIMEOUT_MS, interval: 1_000 },
      );
      expect(await readMessages(sessionKey)).toEqual(completedMessages);
      expect(instance.logs()).not.toContain("Async work scope is closed");
    } finally {
      try {
        await client?.stopAndWait({ timeoutMs: 1_000 });
      } finally {
        await instance.cleanup();
      }
    }
  }, 600_000);
});
