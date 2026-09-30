import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { isLiveTestEnabled, logLiveProgress } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronRunLogEntry } from "../cron/run-log-types.js";
import type { CronJob } from "../cron/types.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

const describeLive =
  isLiveTestEnabled() && process.env.OPENAI_API_KEY?.trim() ? describe : describe.skip;
const MODEL_KEY = "openai/gpt-5.6-luna";
const RUN_TIMEOUT_MS = 180_000;
const SOURCE_KEY = "agent:probe:dashboard:cron-placement-source";

type History = { sessionId: string; messages: unknown[] };

function assistantTexts(messages: unknown[]): string[] {
  return messages
    .filter(isRecord)
    .filter((message) => message.role === "assistant")
    .map(extractAssistantPhaseText)
    .filter((text): text is string => typeof text === "string" && text.length > 0);
}

async function finishedCronRun(client: GatewayClient, jobId: string) {
  const queued = await client.request<{ ok: boolean; enqueued: boolean; runId: string }>(
    "cron.run",
    { id: jobId, mode: "force" },
  );
  expect(queued).toMatchObject({ ok: true, enqueued: true });
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  do {
    const history = await client.request<{ entries: CronRunLogEntry[] }>("cron.runs", {
      id: jobId,
      runId: queued.runId,
    });
    const completed = history.entries.find((entry) => entry.runId === queued.runId);
    if (completed) {
      expect(completed).toMatchObject({
        status: "ok",
        completionStatus: "succeeded",
        provider: "openai",
        model: "gpt-5.6-luna",
      });
      assert(completed.sessionId);
      assert(completed.sessionKey);
      return { ...completed, sessionId: completed.sessionId, sessionKey: completed.sessionKey };
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("The forced cron run did not publish its completion record");
}

describeLive("cron placement identity through production Gateway routing", () => {
  it(
    "writes allowed root replies and rejects a reassigned root's stale generation before execution",
    async ({ signal }) => {
      const instance = await createOpenClawTestInstance({
        name: "cron-placement-live",
        signal,
        env: {
          ...Object.fromEntries(
            listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
          ),
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_BASE_URL: undefined,
          OPENAI_API_BASE: undefined,
          OPENCLAW_AGENT_RUNTIME: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_SKIP_CRON: "0",
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
        },
      });
      let client: GatewayClient | undefined;
      const agentEvents: Array<{ runId: string; stream: string; data: unknown }> = [];
      await runQaGatewayFixture(
        async () => {
          const config: OpenClawConfig = {
            gateway: {
              mode: "local",
              port: instance.port,
              auth: { mode: "token", token: instance.gatewayToken },
              controlUi: { enabled: false },
            },
            agents: {
              defaults: {
                workspace: instance.state.workspaceDir,
                skipBootstrap: true,
                model: { primary: MODEL_KEY },
                models: { [MODEL_KEY]: { agentRuntime: { id: "openclaw" } } },
                thinkingDefault: "low",
                heartbeat: { every: "0m" },
                sandbox: { mode: "off" },
                timeoutSeconds: RUN_TIMEOUT_MS / 1000,
              },
              entries: { probe: { workspace: instance.state.workspaceDir } },
            },
            cron: { enabled: true },
            tools: { allow: [] },
            secrets: { providers: { default: { source: "env" } } },
            models: {
              mode: "merge",
              providers: {
                openai: {
                  api: "openai-responses",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
          };
          await instance.state.writeConfig(config);
          await instance.startGateway();
          const connected = await connectGatewayClient({
            url: instance.url,
            token: instance.gatewayToken,
            clientName: GATEWAY_CLIENT_NAMES.TEST,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            deviceIdentity: loadOrCreateDeviceIdentity({
              path: instance.state.path("placement-client.sqlite"),
            }),
            onEvent: (event) => {
              const payload = event.payload;
              if (
                event.event === "agent" &&
                isRecord(payload) &&
                typeof payload.runId === "string" &&
                typeof payload.stream === "string"
              ) {
                agentEvents.push({
                  runId: payload.runId,
                  stream: payload.stream,
                  data: payload.data,
                });
              }
            },
            timeoutMs: 60_000,
            timeoutMessage: "Cron placement client did not connect",
            signal,
          }).catch((error: unknown) => {
            const logs = instance
              .logs()
              .replaceAll(instance.gatewayToken, "<test-token>")
              .replaceAll(process.env.OPENAI_API_KEY ?? "<missing-key>", "<provider-key>");
            throw new Error(`Cron placement connection failed: ${logs}`, { cause: error });
          });
          client = connected;
          await connected.request("sessions.create", { key: SOURCE_KEY, agentId: "probe" });
          const job = await connected.request<CronJob>("cron.add", {
            agentId: "probe",
            name: "Cron placement authority proof",
            enabled: false,
            schedule: { kind: "every", everyMs: 86_400_000 },
            sessionTarget: "current",
            sessionKey: SOURCE_KEY,
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "Reply exactly SCHEDULED_OK.", toolsAllow: [] },
            delivery: { mode: "none" },
          });
          expect(job).toMatchObject({ sessionTarget: "current", sessionKey: SOURCE_KEY });
          const rootKey = `agent:probe:cron:${job.id}`;
          const describeRoot = () =>
            connected.request<{ session: GatewaySessionRow }>("sessions.describe", {
              key: rootKey,
            });
          const historyFor = (run: CronRunLogEntry) =>
            connected.request<{ messages: unknown[] }>("cron.history", {
              id: job.id,
              runId: run.runId,
              limit: 100,
            });
          const sendRoot = async (marker: string, expectedSessionId: string) => {
            const accepted = await connected.request<{ runId: string; status: string }>("agent", {
              agentId: "probe",
              sessionKey: rootKey,
              expectedExistingSessionId: expectedSessionId,
              message: `Reply with only this token, without punctuation or formatting:\n${marker}`,
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            expect(accepted.status).toBe("accepted");
            const done = await connected.request<{ status: string }>(
              "agent.wait",
              { runId: accepted.runId, timeoutMs: RUN_TIMEOUT_MS },
              { timeoutMs: RUN_TIMEOUT_MS + 5_000 },
            );
            expect(done.status).toBe("ok");
            return accepted.runId;
          };

          const first = await finishedCronRun(connected, job.id);
          expect((await describeRoot()).session).toMatchObject({
            sessionId: first.sessionId,
            placement: { state: "local" },
          });
          const firstSend = await sendRoot("FIRST_ROOT_OK", first.sessionId);
          const rootHistory = await connected.request<History>("chat.history", {
            sessionKey: rootKey,
            limit: 100,
          });
          const sourceHistory = await connected.request<History>("chat.history", {
            sessionKey: SOURCE_KEY,
            limit: 100,
          });
          expect(sourceHistory.messages).toEqual([]);
          const firstTranscript = await historyFor(first);
          expect(firstTranscript.messages).toContainEqual(
            expect.objectContaining({
              role: "assistant",
              __openclaw: expect.objectContaining({ runId: firstSend }),
              content: expect.arrayContaining([
                expect.objectContaining({ type: "text", text: "FIRST_ROOT_OK" }),
              ]),
            }),
          );
          logLiveProgress(
            JSON.stringify({
              step: "first-root-observation",
              sameSessionId: rootHistory.sessionId === first.sessionId,
              streams: agentEvents
                .filter((event) => event.runId === firstSend)
                .map((event) => event.stream),
              rootReplies: assistantTexts(rootHistory.messages),
              recordedReplies: assistantTexts(firstTranscript.messages),
            }),
          );
          expect(rootHistory.sessionId).toBe(first.sessionId);
          expect(
            assistantTexts(firstTranscript.messages),
            JSON.stringify(assistantTexts(firstTranscript.messages)),
          ).toContain("FIRST_ROOT_OK");
          logLiveProgress("cron placement: first root admitted; reply committed to recorded run");

          const second = await finishedCronRun(connected, job.id);
          expect(second.sessionId).not.toBe(first.sessionId);
          expect((await describeRoot()).session).toMatchObject({
            sessionId: second.sessionId,
            placement: { state: "local" },
          });
          const oldBefore = await historyFor(first);
          const newBefore = await historyFor(second);
          const staleRunId = randomUUID();
          await expect(
            connected.request("agent", {
              agentId: "probe",
              sessionKey: rootKey,
              expectedExistingSessionId: first.sessionId,
              message: "Reply exactly STALE_MUST_NOT_EXECUTE.",
              deliver: false,
              idempotencyKey: staleRunId,
            }),
          ).rejects.toThrow("changed before expected work could start");
          expect(agentEvents.filter((event) => event.runId === staleRunId)).toEqual([]);
          expect(await historyFor(first)).toEqual(oldBefore);
          expect(await historyFor(second)).toEqual(newBefore);
          logLiveProgress(
            "cron placement: stale generation rejected; no agent events or transcript writes",
          );

          await sendRoot("SECOND_ROOT_OK", second.sessionId);
          const current = await connected.request<History>("chat.history", {
            sessionKey: rootKey,
            limit: 100,
          });
          expect(current.sessionId).toBe(second.sessionId);
          expect(assistantTexts(current.messages)).toContain("SECOND_ROOT_OK");
          expect(assistantTexts((await historyFor(second)).messages)).toContain("SECOND_ROOT_OK");
          expect(await historyFor(first)).toEqual(oldBefore);
          logLiveProgress(
            "cron placement: fresh root admitted to new run; old transcript unchanged",
          );
        },
        async () => await client?.stopAndWait(),
        () => instance.cleanup(),
      );
    },
    15 * 60_000,
  );
});
