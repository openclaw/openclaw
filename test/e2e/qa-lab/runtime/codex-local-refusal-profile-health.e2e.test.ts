// Product path proof: a host-owned Codex authority refusal must stay inside its own run.
// The shared OAuth profile keeps serving, so the next turn answers on the same credential
// instead of cooling it out for every agent that reuses it.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFailed } from "vitest";
import { loadPersistedSharedAuthProfileStore } from "../../../../src/agents/auth-profiles/persisted.js";
import { isProfileInCooldown } from "../../../../src/agents/auth-profiles/usage-state.js";
import { readRunFailureNotice } from "../../../../src/shared/run-failure-notice.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import { connectGatewayStatusClient } from "../../../helpers/gateway-e2e-harness.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runCodexAuthDoctorMigrationProof } from "./codex-auth-product-proof.test-support.js";

const OAUTH_PROFILE_ID = "openai:qa-oauth";
const PRIMARY_MODEL = "openai/gpt-5.4";
const FALLBACK_MODEL = "openai/gpt-5.4-mini";
const REPAIRED_MODEL_ID = "gpt-5.6-terra";
const LATER_TURN_TEXT = "QA_CODEX_LATER_TURN_OK";
const LOCAL_REFUSAL_USER_COPY = "refused before it reached the AI service";
const RE_LOGIN_ADVICE_MARKERS = ["Couldn't sign in", "Sign in again", "/login openai"];

type AppServerMessage = { method?: string; params?: { threadId?: string; model?: string } };

let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

async function readRequests(log: string): Promise<AppServerMessage[]> {
  const lines = (await fs.readFile(log, "utf8")).trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

it(
  "leaves the shared profile serving after a local Codex owner refusal",
  { timeout: 180_000 },
  async () => {
    const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
      CODEX_APP_SERVER_VERSION: string;
    }>({ pluginId: "codex", artifactBasename: "test-api.js" });
    const nativeRuntime = { agentRuntime: { id: "codex" } };
    instance = await createOpenClawTestInstance({
      name: "qa-codex-local-refusal-health",
      env: {
        OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
        OPENCLAW_QA_CODEX_FAILURE_KIND: "local-owner",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        // Credential health and profile rotation need the real Gateway process owner.
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      config: {
        plugins: {
          enabled: true,
          allow: ["codex"],
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  mode: "yolo",
                  command: process.execPath,
                  args: [
                    fileURLToPath(
                      new URL("./codex-refusal-app-server.fixture.mjs", import.meta.url),
                    ),
                  ],
                  requestTimeoutMs: 60_000,
                },
              },
            },
          },
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
    const requestLog = currentInstance.state.path("codex-local-refusal-app-server.jsonl");
    currentInstance.env.OPENCLAW_QA_CODEX_REFUSAL_APP_SERVER_LOG = requestLog;
    await runCodexAuthDoctorMigrationProof(currentInstance, {
      accountId: "qa-codex-refusal-health",
      oauthAccess: "synthetic-local-owner-refusal-oauth",
      shape: "oauth-only",
    });
    await currentInstance.startGateway();

    const client = await connectGatewayStatusClient(currentInstance);
    try {
      const sessionKey = `agent:main:codex-local-refusal-${randomUUID()}`;
      const send = async (message: string) => {
        const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(started.status).toBe("started");
        const terminal = await client.request<{ status?: string; error?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
        return { runId: started.runId, terminal };
      };

      const refused = await send("Exercise the local owner refusal.");
      const history = await client.request<{
        messages?: Array<{ role?: unknown; content?: unknown }>;
      }>("chat.history", { sessionKey, limit: 20 });
      const serializedHistory = JSON.stringify(history);
      const refusalDiagnosis = `${JSON.stringify(refused.terminal)}\n${serializedHistory}\n${currentInstance.logs()}`;

      // The stored credential is the fact the issue is about: a refusal that never reached
      // the provider must not open a cooldown window for every sibling agent. Read it through
      // the owner's predicate, which resolves the persisted usageStats windows.
      const store = loadPersistedSharedAuthProfileStore(currentInstance.env);
      expect(store?.profiles[OAUTH_PROFILE_ID], refusalDiagnosis).toBeDefined();
      const cooledAfterRefusal = store
        ? isProfileInCooldown(store, OAUTH_PROFILE_ID, undefined, REPAIRED_MODEL_ID)
        : true;
      expect(cooledAfterRefusal, refusalDiagnosis).toBe(false);

      expect(refused.terminal.status, refusalDiagnosis).toBe("error");
      const failureNotices = (history.messages ?? [])
        .map(readRunFailureNotice)
        .filter(Boolean) as Array<{ summary?: string }>;
      expect(failureNotices, refusalDiagnosis).toHaveLength(1);
      expect(failureNotices[0]?.summary, refusalDiagnosis).toContain(LOCAL_REFUSAL_USER_COPY);
      for (const marker of RE_LOGIN_ADVICE_MARKERS) {
        expect(serializedHistory, refusalDiagnosis).not.toContain(marker);
      }

      const sibling = await send("Complete this ordinary later turn.");
      const laterHistory = await client.request<{
        messages?: Array<{ role?: unknown; content?: unknown }>;
      }>("chat.history", { sessionKey, limit: 20 });
      const laterSerialized = JSON.stringify(laterHistory);
      expect(sibling.terminal.status, `${laterSerialized}\n${currentInstance.logs()}`).toBe("ok");

      const entries = await readRequests(requestLog);
      const turnStarts = entries.filter((entry) => entry.method === "turn/start");
      const laterStore = loadPersistedSharedAuthProfileStore(currentInstance.env);
      const cooledAfterSibling = laterStore
        ? isProfileInCooldown(laterStore, OAUTH_PROFILE_ID, undefined, REPAIRED_MODEL_ID)
        : true;
      const proof = {
        turnStartCount: turnStarts.length,
        selectedModels: [...new Set(turnStarts.map((entry) => entry.params?.model))],
        laterStatus: sibling.terminal.status,
        laterReplySeen: laterSerialized.includes(LATER_TURN_TEXT),
        cooledAfterRefusal,
        cooledAfterSibling,
      };
      console.log(`[gateway local refusal health proof] ${JSON.stringify(proof)}`);
      expect(proof).toEqual({
        // One refused run plus one ordinary later turn, on the same model and credential:
        // neither the profile chain nor the model fallback chain was consumed, and the
        // shared profile never entered a cooldown window at any point.
        turnStartCount: 2,
        selectedModels: [REPAIRED_MODEL_ID],
        laterStatus: "ok",
        laterReplySeen: true,
        cooledAfterRefusal: false,
        cooledAfterSibling: false,
      });
    } finally {
      client.stop();
    }
  },
);
