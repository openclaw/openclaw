import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFailed } from "vitest";
import { readRunFailureNotice } from "../../../../src/shared/run-failure-notice.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import { connectGatewayStatusClient } from "../../../helpers/gateway-e2e-harness.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runCodexAuthDoctorMigrationProof } from "./codex-auth-product-proof.test-support.js";

const PRIMARY_MODEL = "openai/gpt-5.4";
const FALLBACK_MODEL = "openai/gpt-5.4-mini";
const REPAIRED_MODEL_ID = "gpt-5.6-terra";
const REPAIRED_FALLBACK_MODEL = "openai/gpt-5.6-luna";
const LATER_TURN_TEXT = "QA_CODEX_LATER_TURN_OK";
type AppServerMessage = {
  method?: string;
  params?: { threadId?: string; model?: string; status?: { type?: string } };
};
let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

function messageText(content: unknown): string {
  const parts: unknown[] = Array.isArray(content) ? content : [{ text: content }];
  return parts
    .flatMap((part: unknown) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

async function readRequests(log: string): Promise<AppServerMessage[]> {
  const lines = (await fs.readFile(log, "utf8")).trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

it.each(["bio", "cyber", "misalignment", "retryable"])(
  "Gateway Codex failure recovery with automatic cyber failover off %s preserves terminal, review, and retry behavior on the same native thread",
  { timeout: 180_000 },
  async (failureKind) => {
    const paused = failureKind === "misalignment";
    const retryable = failureKind === "retryable";
    const terminalFailureSummary = retryable
      ? undefined
      : paused
        ? "Your request couldn't be completed: Chat stopped as a precaution. Review the findings in chat before continuing."
        : `Your request couldn't be completed: The provider refused this request (category: ${failureKind}). Revise the request and try again.`;
    const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
      CODEX_APP_SERVER_VERSION: string;
    }>({ pluginId: "codex", artifactBasename: "test-api.js" });
    const appServer = {
      mode: "yolo",
      command: process.execPath,
      args: [fileURLToPath(new URL("./codex-refusal-app-server.fixture.mjs", import.meta.url))],
      requestTimeoutMs: 60_000,
      cyberFailover: { mode: "off" },
    };
    const nativeRuntime = { agentRuntime: { id: "codex" } };
    instance = await createOpenClawTestInstance({
      name: "qa-codex-refusal-product-proof",
      env: {
        OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
        OPENCLAW_QA_CODEX_FAILURE_KIND: failureKind,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        // Native task admission needs the configured owner published by full Gateway startup.
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      config: {
        plugins: {
          enabled: true,
          allow: ["codex"],
          entries: { codex: { enabled: true, config: { appServer } } },
        },
        agents: {
          defaults: {
            model: { primary: PRIMARY_MODEL, fallbacks: [FALLBACK_MODEL] },
            models: { [PRIMARY_MODEL]: nativeRuntime, [FALLBACK_MODEL]: nativeRuntime },
            workspace: "~/workspace",
            skipBootstrap: true,
            timeoutSeconds: 60,
            sandbox: { mode: "off" },
          },
        },
      },
    });
    const currentInstance = instance;
    onTestFailed(() => console.error(currentInstance.logs()));
    const requestLog = instance.state.path("codex-refusal-app-server.jsonl");
    instance.env.OPENCLAW_QA_CODEX_REFUSAL_APP_SERVER_LOG = requestLog;
    await runCodexAuthDoctorMigrationProof(instance, {
      accountId: "qa-codex-refusal",
      oauthAccess: "synthetic-codex-refusal-oauth",
      shape: "oauth-only",
    });
    const config = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
    expect(config.agents?.defaults?.model).toMatchObject({
      primary: `openai/${REPAIRED_MODEL_ID}`,
      fallbacks: [REPAIRED_FALLBACK_MODEL],
    });
    await instance.startGateway();
    const client = await connectGatewayStatusClient(instance);
    try {
      const sessionKey = `agent:main:codex-refusal-${randomUUID()}`;
      const send = async (message: string) => {
        const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(started.status).toBe("started");
        const terminal = await client.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        console.log(`[gateway Codex terminal] ${JSON.stringify({ message, terminal })}`);
        return { runId: started.runId, status: terminal.status };
      };

      const { runId: firstRunId, status: firstStatus } = await send(
        "Exercise the harmless synthetic protocol failure.",
      );
      const firstEntries = await readRequests(requestLog);
      const firstTurnStarts = firstEntries.filter((entry) => entry.method === "turn/start");
      expect(firstTurnStarts).toHaveLength(retryable ? 2 : 1);
      expect(firstStatus).toBe(retryable ? "ok" : "error");
      expect(firstEntries.some((entry) => entry.method === "thread/compact/start")).toBe(false);
      expect(firstEntries).toContainEqual({
        method: "thread/status/changed",
        params: {
          threadId: firstTurnStarts[0]?.params?.threadId,
          status: { type: "systemError" },
        },
      });

      let laterStatus: string | undefined;
      if (paused) {
        await expect(send("Complete this ordinary later turn.")).rejects.toThrow(
          "paused as a precaution",
        );
        laterStatus = "blocked";
        const session = await client.request<{ session: { providerReview?: unknown } }>(
          "sessions.describe",
          { key: sessionKey },
        );
        expect(session.session.providerReview).toMatchObject({ canContinue: false });
      } else {
        laterStatus = (await send("Complete this ordinary later turn.")).status;
      }
      const history = await client.request<{
        messages?: Array<{ role?: unknown; content?: unknown }>;
      }>("chat.history", { sessionKey, limit: 20 });
      const assistantTexts = (history.messages ?? [])
        .filter((message) => message.role === "assistant")
        .map((message) => messageText(message.content))
        .filter(Boolean);
      const allEntries = await readRequests(requestLog);
      const allTurnStarts = allEntries.filter((entry) => entry.method === "turn/start");
      const proof = {
        visibleReplies: assistantTexts,
        failureNotices: (history.messages ?? []).map(readRunFailureNotice).filter(Boolean),
        laterStatus,
        totalTurnStartCount: allTurnStarts.length,
        threadStartCount: allEntries.filter((entry) => entry.method === "thread/start").length,
        nativeThreadIds: [...new Set(allTurnStarts.map((entry) => entry.params?.threadId))],
        selectedModels: [...new Set(allTurnStarts.map((entry) => entry.params?.model))],
      };
      console.log(`[gateway Codex failure recovery proof] ${JSON.stringify(proof)}`);
      expect(proof).toEqual({
        visibleReplies: Array<string>(paused ? 0 : retryable ? 2 : 1).fill(LATER_TURN_TEXT),
        failureNotices: terminalFailureSummary
          ? [{ runId: firstRunId, summary: terminalFailureSummary }]
          : [],
        laterStatus: paused ? "blocked" : "ok",
        totalTurnStartCount: paused ? 1 : retryable ? 3 : 2,
        threadStartCount: 1,
        nativeThreadIds: [expect.any(String)],
        selectedModels: [REPAIRED_MODEL_ID],
      });
      expect(JSON.stringify(history)).not.toMatch(/biological risk|\/new/);
    } finally {
      client.stop();
    }
  },
);
