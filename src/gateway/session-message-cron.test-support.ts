import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, test } from "vitest";
import type { WebSocket } from "ws";
import { resolveCronDeliveryPlan } from "../cron/delivery-plan.js";
import type { DispatchCronDeliveryParams } from "../cron/isolated-agent/delivery-dispatch-types.js";
import { dispatchCronDelivery } from "../cron/isolated-agent/delivery-dispatch.js";
import type { CronStoredJob } from "../cron/types.js";
import {
  type createGatewaySuiteHarness,
  type onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

const requireRecord = createRequireRecord("object", "expected-label-object");

type SessionEventHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

export function registerCronSessionCompletionEventTests({
  getHarness,
  createSessionStoreFile,
  connectSessionClient,
  waitForSessionMessageEvent,
}: {
  getHarness: () => SessionEventHarness;
  createSessionStoreFile: () => Promise<string>;
  connectSessionClient: (
    ws: WebSocket,
    storePath: string,
    identityFile: string,
    kind: "web",
  ) => Promise<void>;
  waitForSessionMessageEvent: (ws: WebSocket, sessionKey: string) => ReturnType<typeof onceMessage>;
}) {
  test.each(["current", "isolated"] as const)(
    "publishes a %s completion live and restores it once from WebChat history after retry",
    async (sessionTarget) => {
      const harness = getHarness();
      const storePath = await createSessionStoreFile();
      const sessionId = "sess-current-cron-completion";
      const sessionKey = "agent:main:webchat:direct:cron-owner";
      await writeSessionStore({
        entries: {
          "webchat:direct:cron-owner": {
            sessionId,
            lifecycleRevision: "current-cron-revision",
            updatedAt: Date.now(),
          },
        },
        storePath,
      });

      const webWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
      let reconnectedWebWs: Awaited<ReturnType<typeof harness.openWs>> | undefined;
      try {
        await connectSessionClient(webWs, storePath, "current-cron-web-device.json", "web");
        await rpcReq(webWs, "sessions.messages.subscribe", { key: sessionKey });

        const job: CronStoredJob = {
          id: "job-webchat",
          name: "Current WebChat completion",
          sessionTarget,
          sessionKey,
          ...(sessionTarget === "isolated"
            ? {
                sourceConversation: {
                  sessionKey,
                  sessionId,
                  lifecycleRevision: "current-cron-revision",
                },
              }
            : {}),
          delivery: { mode: "announce", channel: "last" },
          wakeMode: "now",
          enabled: true,
          state: {},
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "at", at: "2030-01-01T00:00:00.000Z" },
          payload: { kind: "agentTurn", message: "Finish later" },
        };
        const liveEventPromise = waitForSessionMessageEvent(webWs, sessionKey);
        const deliveryParams: DispatchCronDeliveryParams = {
          cfgWithAgentDefaults: { session: { store: storePath } },
          deps: {},
          job,
          deliveryAttemptFence: null,
          agentId: "main",
          agentSessionKey: "cron:job-webchat",
          sourceSessionKey: sessionKey,
          sourceSessionGeneration: {
            sessionId,
            lifecycleRevision: "current-cron-revision",
          },
          runSessionKey: "cron:job-webchat:run:3000",
          sessionId: "detached-cron-session",
          lifecycleRevision: "detached-cron-revision",
          sessionUpdatedAt: 3_000,
          runStartedAt: 3_000,
          timeoutMs: 30_000,
          resolvedDelivery: {
            ok: false,
            channel: "webchat",
            mode: "implicit",
            error: new Error("WebChat uses canonical session events"),
          },
          deliveryPlan: resolveCronDeliveryPlan(job),
          deliveryRequested: true,
          undeliveredRunStatus: "ok",
          spawnOnlyHandoff: false,
          sourceDeliveryOutcome: {
            visibleDeliveries: [],
            verifiedMessageToolDelivery: false,
            satisfiesSourceDelivery: false,
            unverifiedMessageToolDelivery: false,
          },
          deliveryBestEffort: false,
          deliveryPayloadHasStructuredContent: false,
          deliveryPayloads: [{ text: "The detached cron finished without another user message." }],
          synthesizedText: "The detached cron finished without another user message.",
          summary: "The detached cron finished without another user message.",
          outputText: "The detached cron finished without another user message.",
          isAborted: () => false,
          abortReason: () => "aborted",
        };
        const dispatched = await dispatchCronDelivery(deliveryParams);
        expect(dispatched).toMatchObject({ delivered: true, deliveryAttempted: true });

        const liveEvent = await liveEventPromise;
        const livePayload = requireRecord(liveEvent.payload, "background completion event");
        expect(livePayload.message).toMatchObject({
          __openclaw: {
            idempotencyKey: "cron-current-completion:cron:job-webchat:3000",
          },
          content: [
            { type: "text", text: "The detached cron finished without another user message." },
          ],
          openclawAutomation: {
            kind: "cron",
            jobId: "job-webchat",
            runId: "cron:job-webchat:3000",
          },
          role: "assistant",
        });
        await expect(dispatchCronDelivery(deliveryParams)).resolves.toMatchObject({
          delivered: true,
        });

        webWs.close();
        reconnectedWebWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
        await connectSessionClient(
          reconnectedWebWs,
          storePath,
          "current-cron-web-device.json",
          "web",
        );
        const history = await rpcReq<{ messages?: unknown[] }>(reconnectedWebWs, "chat.history", {
          sessionKey,
        });
        expect(history.ok).toBe(true);
        expect(history.payload?.messages).toHaveLength(1);
        expect(history.payload?.messages).toContainEqual(
          expect.objectContaining({
            __openclaw: expect.objectContaining({
              id: livePayload.messageId,
              idempotencyKey: "cron-current-completion:cron:job-webchat:3000",
              seq: 1,
            }),
            content: [
              { type: "text", text: "The detached cron finished without another user message." },
            ],
            openclawAutomation: {
              kind: "cron",
              jobId: "job-webchat",
              runId: "cron:job-webchat:3000",
            },
            role: "assistant",
          }),
        );
      } finally {
        webWs.close();
        reconnectedWebWs?.close();
      }
    },
  );
}
