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
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";

const enabled = isLiveTestEnabled() && process.env.OPENCLAW_LIVE_SESSION_EVENT_WAKE === "1";
const describeLive = enabled ? describe : describe.skip;
const TURN_TIMEOUT_MS = 180_000;
const MODEL = "openai/gpt-5.6-luna";

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

async function sendChatTurn(client: GatewayClient, sessionKey: string, message: string) {
  const started = await client.request<{ runId: string }>("chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    timeoutMs: 170_000,
    message,
  });
  return client.request<{ status: string }>(
    "agent.wait",
    { runId: started.runId, timeoutMs: TURN_TIMEOUT_MS },
    { timeoutMs: TURN_TIMEOUT_MS + 5_000 },
  );
}

async function writeGateFixture(workspace: string, name: string, output: string, exitCode: number) {
  await fs.writeFile(
    path.join(workspace, `${name}-gate.cjs`),
    [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(`${name}-started`)}, "started");`,
      "const deadline = Date.now() + 180000;",
      "const timer = setInterval(() => {",
      `  if (fs.existsSync(${JSON.stringify(`release-${name}`)})) {`,
      "    clearInterval(timer);",
      `    console.${exitCode === 0 ? "log" : "error"}(${JSON.stringify(output)});`,
      `    fs.writeFileSync(${JSON.stringify(`${name}-completed`)}, "completed");`,
      `    process.exitCode = ${exitCode};`,
      "  } else if (Date.now() > deadline) {",
      "    clearInterval(timer);",
      '    console.error("Live fixture gate was not released");',
      "    process.exitCode = 1;",
      "  }",
      "}, 50);",
    ].join("\n"),
  );
}

describeLive("session event wake through a live Gateway", () => {
  it.each([
    { outcome: "success and keeps monitor polls on main", exitCode: 0, busySibling: false },
    { outcome: "watcher failure during another session", exitCode: 7, busySibling: true },
  ])(
    "continues a completed foreground session for $outcome",
    async ({ exitCode, busySibling }) => {
      if (!process.env.OPENAI_API_KEY?.trim()) {
        throw new Error("OPENCLAW_LIVE_SESSION_EVENT_WAKE requires OPENAI_API_KEY");
      }
      const instance = await createOpenClawTestInstance({
        name: "live-session-event-wake",
        env: {
          ...Object.fromEntries(
            listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
          ),
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
      let siblingRun: ReturnType<typeof sendChatTurn> | undefined;
      let siblingSettled = false;
      const sessionKey = `agent:main:dashboard:${randomUUID()}`;
      const siblingSessionKey = `agent:main:dashboard:${randomUUID()}`;
      const mainSessionKey = "agent:main:main";
      const nonce = randomUUID();
      const startedReply = `STARTED-${nonce}`;
      const completionReply = `${exitCode === 0 ? "COMPLETION" : "WATCHER-FAILED"}-${nonce}`;
      const followupReply = busySibling ? `${completionReply} | code ${exitCode}` : "NO_REPLY";
      const siblingReply = `SIBLING-FINISHED-${nonce}`;
      const monitorReply = `MAIN-MONITOR-${nonce}`;
      const workspace = instance.state.workspaceDir;
      const gatePath = path.join(workspace, "release-completion");
      const siblingGatePath = path.join(workspace, "release-sibling");
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
        await writeGateFixture(workspace, "completion", completionReply, exitCode);
        if (busySibling) {
          await writeGateFixture(workspace, "sibling", siblingReply, 0);
        }
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
              maxConcurrent: 2,
              thinkingDefault: "low",
              timeoutSeconds: 170,
              model: { primary: MODEL },
              models: { [MODEL]: { agentRuntime: { id: "openclaw" } } },
              sandbox: { mode: "off" },
              heartbeat: {
                every: "24h",
                target: busySibling ? "last" : "none",
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
        const created = await client.request<{ key: string }>("sessions.create", {
          agentId: "main",
          key: sessionKey,
          displayName: "Live watcher completion",
        });
        expect(created.key).toBe(sessionKey);
        const response = await sendChatTurn(
          client,
          sessionKey,
          [
            "Start the existing completion-gate.cjs fixture using the shell exec tool, command node completion-gate.cjs, with background true and timeoutSeconds 180.",
            "Use Code Mode to invoke the shell exec tool. Do not read, modify, or run any other file. Do not poll or wait for the process.",
            `Once exec returns its running session, reply exactly ${startedReply} and end this turn.`,
            busySibling
              ? "When its later completion arrives, reply exactly with the output marker followed by ' | code ' and its reported numeric exit code. Do not call any tools for that completion."
              : "Handle its later completion silently with NO_REPLY; this fixture disables notification delivery.",
          ].join("\n"),
        );
        expect(response.status).toBe("ok");
        expect(loadGatewaySessionEntryReadOnly(sessionKey).entry).toMatchObject({
          createdVia: "operator",
          delivery: { kind: "internal" },
        });
        expect(await fs.readFile(path.join(workspace, "completion-started"), "utf8")).toBe(
          "started",
        );
        const foregroundMessages = await readMessages(sessionKey);
        expect(messagesWithRole(foregroundMessages, "assistant")).toContain(startedReply);
        expect(messagesWithRole(foregroundMessages, "assistant")).not.toContain(completionReply);
        await expect(fs.access(path.join(workspace, "completion-completed"))).rejects.toThrow();

        if (busySibling) {
          await client.request("sessions.create", {
            agentId: "main",
            key: siblingSessionKey,
            displayName: "Live busy sibling",
          });
          siblingRun = sendChatTurn(
            client,
            siblingSessionKey,
            [
              "Use Code Mode to invoke the shell exec tool with command node sibling-gate.cjs, background false, yieldMs 120000, and timeoutSeconds 180.",
              "Do not read, modify, or run any other file. Wait for this command to finish; if exec returns a running session, collect its result using process poll before replying.",
              `Only after the command completes, reply exactly ${siblingReply}.`,
            ].join("\n"),
          );
          void siblingRun.then(
            () => {
              siblingSettled = true;
            },
            () => {
              siblingSettled = true;
            },
          );
          await vi.waitFor(
            async () => {
              expect(await fs.readFile(path.join(workspace, "sibling-started"), "utf8")).toBe(
                "started",
              );
            },
            { timeout: TURN_TIMEOUT_MS, interval: 100 },
          );
          expect(siblingSettled).toBe(false);
        }

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
                    expect.objectContaining({ type: "text", text: followupReply }),
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
        expect(await fs.readFile(path.join(workspace, "completion-completed"), "utf8")).toBe(
          "completed",
        );
        expect(await readMessages(mainSessionKey)).toEqual([]);

        if (siblingRun) {
          expect(siblingSettled).toBe(false);
          await expect(fs.access(path.join(workspace, "sibling-completed"))).rejects.toThrow();
          expect(messagesWithRole(await readMessages(siblingSessionKey), "user")).not.toContain(
            completionReply,
          );
          await fs.writeFile(siblingGatePath, "release");
          const siblingResponse = await siblingRun;
          expect(siblingResponse.status).toBe("ok");
          expect(messagesWithRole(await readMessages(siblingSessionKey), "assistant")).toContain(
            siblingReply,
          );
        }

        // The silent-success case also exercises scheduled monitoring; target:last
        // on the failure case's untouched main session has no delivery route.
        if (!busySibling) {
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
        }
        expect(await readMessages(sessionKey)).toEqual(completedMessages);
        expect(instance.logs()).not.toContain("Async work scope is closed");
      } finally {
        try {
          await Promise.all([
            fs.writeFile(gatePath, "release"),
            fs.writeFile(siblingGatePath, "release"),
          ]);
        } finally {
          try {
            await client?.stopAndWait({ timeoutMs: 1_000 });
          } finally {
            try {
              await siblingRun?.catch(() => undefined);
            } finally {
              await instance.cleanup();
            }
          }
        }
      }
    },
    600_000,
  );
});
