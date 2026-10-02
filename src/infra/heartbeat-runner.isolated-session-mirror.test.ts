import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerWhatsAppPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { buildChannelOutboundSessionRoute } from "../plugin-sdk/core.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveHeartbeatPreflight } from "./heartbeat-runner-prompt.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  type HeartbeatReplySpy,
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

const beforeMockDeliveryCompletion = vi.hoisted(() => vi.fn(async () => {}));
const beforeMockDeliveryConfirmation = vi.hoisted(() => vi.fn(async () => {}));
const deliverOutboundPayloadsInternal = vi.hoisted(() =>
  vi.fn(async (request: MockDeliveryRequest) => {
    const payload = request.payloads?.[0];
    await beforeMockDeliveryConfirmation();
    request.onDeliveredPayload?.({
      text: payload?.text ?? "",
      mediaUrls: [payload?.mediaUrl, ...(payload?.mediaUrls ?? [])].filter((url): url is string =>
        Boolean(url),
      ),
    });
    await beforeMockDeliveryCompletion();
    return [{ channel: "whatsapp", messageId: "msg-1" }];
  }),
);

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  beforeMockDeliveryConfirmation.mockReset();
  beforeMockDeliveryConfirmation.mockResolvedValue(undefined);
  beforeMockDeliveryCompletion.mockReset();
  beforeMockDeliveryCompletion.mockResolvedValue(undefined);
  deliverOutboundPayloadsInternal.mockClear();
  resetSystemEventsForTest();
});

const latestDeliveryRequest = () => deliverOutboundPayloadsInternal.mock.calls.at(-1)?.[0];

function installWhatsAppRoute(options?: { exact?: boolean }) {
  const plugin: ChannelPlugin = {
    ...heartbeatRunnerWhatsAppPlugin,
    capabilities: {
      ...heartbeatRunnerWhatsAppPlugin.capabilities,
      chatTypes: ["direct"],
    },
    messaging: {
      ...heartbeatRunnerWhatsAppPlugin.messaging,
      targetResolver: { looksLikeId: () => true },
      ...(options?.exact === true
        ? {
            resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) =>
              buildChannelOutboundSessionRoute({
                cfg,
                agentId,
                channel: "whatsapp",
                accountId,
                recipientSessionExact: true,
                peer: { kind: "direct", id: target },
                chatType: "direct",
                from: target,
                to: target,
              }),
          }
        : {}),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "whatsapp", plugin, source: "test" }]));
}

type MirrorFixture = Awaited<ReturnType<typeof createMirrorFixture>>;
function withMirror(
  fn: (fixture: MirrorFixture) => Promise<void>,
  projection: boolean | "inexact" = true,
) {
  return withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) =>
    fn(await createMirrorFixture(tmpDir, storePath, replySpy, projection)),
  );
}
async function createMirrorFixture(
  tmpDir: string,
  storePath: string,
  replySpy: HeartbeatReplySpy,
  projection: boolean | "inexact",
) {
  const cfg = heartbeatTestConfig(tmpDir, "last", "whatsapp", storePath);
  cfg.agents!.list = [{ id: "main", default: true }];
  cfg.agents!.defaults!.heartbeat!.isolatedSession = true;
  if (projection) {
    installWhatsAppRoute({ exact: projection !== "inexact" });
    cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
  }
  const baseKey = resolveMainSessionKey(cfg);
  const isolatedKey = `${baseKey}:heartbeat`;
  const target = "+15551234567";
  const targetKey = `agent:main:whatsapp:direct:${target}`;
  const nowMs = Date.now();
  const delivery = {
    updatedAt: nowMs - 1000,
    lastChannel: "whatsapp",
    lastProvider: "whatsapp",
    lastTo: target,
  };
  await seedSessionStore(storePath, baseKey, { ...delivery, sessionId: "base-session" });
  const replaceTarget = (lifecycleRevision: string) =>
    seedSessionStore(storePath, targetKey, {
      ...delivery,
      sessionId: "target-session",
      lifecycleRevision,
    });
  if (projection) {
    await replaceTarget("target-lifecycle-1");
  }
  replySpy.mockResolvedValueOnce({ text: "Status needs attention." });
  const run = (wake: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps"> = {}) =>
    runHeartbeatOnce({
      cfg,
      ...wake,
      deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, nowMs: () => nowMs },
    });
  const awareness = () =>
    drainFormattedSystemEvents({
      cfg,
      agentId: "main",
      sessionKey: targetKey,
      isMainSession: false,
      isNewSession: false,
    });
  return {
    cfg,
    storePath,
    replySpy,
    baseKey,
    isolatedKey,
    targetKey,
    target,
    nowMs,
    run,
    awareness,
    replaceTarget,
  };
}

describe("runHeartbeatOnce - isolated heartbeat outbound session mirror", () => {
  it("keeps the base policy key when wake re-entry starts from the isolated key", async () => {
    await withMirror(async ({ storePath, replySpy, baseKey, isolatedKey, nowMs, run }) => {
      await seedSessionStore(storePath, isolatedKey, {
        sessionId: "isolated-session",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseKey,
      });
      enqueueSystemEvent("Exec completed (mirror-reentry, code 0) :: result needs attention", {
        sessionKey: isolatedKey,
      });
      const result = await run({
        sessionKey: isolatedKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
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
    }, false);
  });

  it("queues a successful direct alert for the next ordinary target turn", async () => {
    await withMirror(async ({ cfg, target, targetKey, run, awareness }) => {
      const observations: Array<{
        pendingEventEntries: Awaited<
          ReturnType<typeof resolveHeartbeatPreflight>
        >["pendingEventEntries"];
        preflightContext: Awaited<ReturnType<typeof drainFormattedSystemEvents>>;
        context: Awaited<ReturnType<typeof awareness>>;
        repeatedContext: Awaited<ReturnType<typeof awareness>>;
      }> = [];
      // Observe publication after confirmation, while the transport still owns completion.
      beforeMockDeliveryCompletion.mockImplementationOnce(async () => {
        const nextHeartbeatPreflight = await resolveHeartbeatPreflight({
          cfg,
          agentId: "main",
          sessionKey: targetKey,
          heartbeat: { isolatedSession: true },
        });
        observations.push({
          pendingEventEntries: nextHeartbeatPreflight.pendingEventEntries,
          preflightContext: await drainFormattedSystemEvents({
            cfg,
            agentId: "main",
            sessionKey: targetKey,
            isMainSession: false,
            isNewSession: false,
            events: nextHeartbeatPreflight.pendingEventEntries,
          }),
          context: await awareness(),
          repeatedContext: await awareness(),
        });
      });
      await expect(run()).resolves.toMatchObject({ status: "ran" });
      expect(beforeMockDeliveryCompletion).toHaveBeenCalledOnce();
      expect(observations).toEqual([
        {
          pendingEventEntries: [],
          preflightContext: undefined,
          context: expect.stringContaining("A heartbeat delivered this message to this channel:"),
          repeatedContext: undefined,
        },
      ]);
      expect(observations[0]?.context).toContain("Status needs attention.");
      expect(latestDeliveryRequest()).toMatchObject({ channel: "whatsapp", to: target });
    });
  });

  it.each(["inexact route", "failed delivery", "replaced lifecycle"] as const)(
    "does not project an alert after %s",
    async (scenario) => {
      await withMirror(
        async ({ run, awareness, replaceTarget }) => {
          if (scenario === "failed delivery") {
            deliverOutboundPayloadsInternal.mockRejectedValueOnce(new Error("channel unavailable"));
          } else if (scenario === "replaced lifecycle") {
            beforeMockDeliveryConfirmation.mockImplementationOnce(() =>
              replaceTarget("target-lifecycle-2"),
            );
          }
          const result = await run();
          expect(result.status).toBe(scenario === "failed delivery" ? "failed" : "ran");
          if (scenario === "inexact route") {
            expect(latestDeliveryRequest()).toMatchObject({
              channel: "whatsapp",
              to: "+15551234567",
            });
          }
          await expect(awareness()).resolves.toBeUndefined();
        },
        scenario === "inexact route" ? "inexact" : true,
      );
    },
  );
});
