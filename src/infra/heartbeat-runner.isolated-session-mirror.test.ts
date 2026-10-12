import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  heartbeatTestConfig,
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

type MockDeliveryRequest = {
  channel?: string;
  to?: string;
  session?: { key?: string; policyKey?: string };
  payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
  onDeliveredPayload?: (payload: { text: string; mediaUrls: string[] }) => void;
};

const deliverOutboundPayloadsInternal = vi.hoisted(() =>
  vi.fn(async (request: MockDeliveryRequest) => {
    const payload = request.payloads?.[0];
    request.onDeliveredPayload?.({
      text: payload?.text ?? "",
      mediaUrls: [payload?.mediaUrl, ...(payload?.mediaUrls ?? [])].filter((url): url is string =>
        Boolean(url),
      ),
    });
    return [{ channel: "whatsapp", messageId: "msg-1" }];
  }),
);

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  deliverOutboundPayloadsInternal.mockClear();
  resetSystemEventsForTest();
});

const latestDeliveryRequest = () => deliverOutboundPayloadsInternal.mock.calls.at(-1)?.[0];

describe("runHeartbeatOnce - isolated heartbeat outbound session mirror", () => {
  it("keeps the base policy key when wake re-entry starts from the isolated key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "last", "whatsapp", storePath);
      cfg.agents!.entries = { main: {} };
      cfg.agents!.defaults!.heartbeat!.isolatedSession = true;
      const baseKey = resolveMainSessionKey(cfg);
      const isolatedKey = `${baseKey}:heartbeat`;
      const nowMs = Date.now();
      await seedSessionStore(storePath, baseKey, {
        updatedAt: nowMs - 1_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
        sessionId: "base-session",
      });
      replySpy.mockResolvedValueOnce({ text: "Status needs attention." });
      await seedSessionStore(storePath, isolatedKey, {
        sessionId: "isolated-session",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseKey,
      });
      enqueueSystemEvent("Exec completed (mirror-reentry, code 0) :: result needs attention", {
        sessionKey: isolatedKey,
      });
      const result = await runHeartbeatOnce({
        cfg,
        sessionKey: isolatedKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, nowMs: () => nowMs },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: isolatedKey,
      });
      expect(latestDeliveryRequest()).toMatchObject({
        channel: "whatsapp",
        to: "+15551234567",
        session: {
          key: isolatedKey,
          policyKey: baseKey,
        },
      });
      const store = readSessionStoreForTest(storePath);
      expect(store[baseKey]).toMatchObject({
        lastHeartbeatText: "Status needs attention.",
        lastHeartbeatSentAt: nowMs,
      });
      expect(store[isolatedKey]?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
      expect(store[isolatedKey]?.lastHeartbeatText).toBeUndefined();
    });
  });
});
