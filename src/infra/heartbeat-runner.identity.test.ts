import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedSessionStore,
  seedMainSessionStore,
  readSessionStoreForTest,
  withTempHeartbeatSandbox,
  type HeartbeatReplySpy,
} from "./heartbeat-runner.test-utils.js";
import { withSystemEventOwner } from "./system-event-ownership.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

function mockReplyWithSystemEvents(replySpy: HeartbeatReplySpy, cfg: OpenClawConfig) {
  const blocks: Array<string | undefined> = [];
  replySpy.mockImplementation(async (ctx, opts) => {
    const eventContext = getReplySystemEventContext(opts);
    const sessionKey = eventContext?.sessionKey ?? ctx.SessionKey;
    if (!ctx.AgentId || !sessionKey) {
      throw new Error("Expected heartbeat agent and session context");
    }
    blocks.push(
      await drainFormattedSystemEvents({
        cfg,
        agentId: ctx.AgentId,
        sessionKey,
        isMainSession: false,
        isNewSession: false,
        events: eventContext?.events ?? [],
      }),
    );
    return { text: "HEARTBEAT_OK" };
  });
  return blocks;
}

describe("runHeartbeatOnce identity", () => {
  afterEach(() => resetSystemEventsForTest());

  it("keeps isolated global delivery and identity in the selected agent store", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last", isolatedSession: true },
          },
          entries: {
            main: {},
            historian2: { identity: { name: "Pulse", emoji: "📟" } },
          },
        },
        session: { scope: "global", dmScope: "per-channel-peer", store: storeTemplate },
      };
      const mainStorePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main" });
      const historianScope = {
        agentId: "historian2",
        storePath: resolveSessionStorePathCore(storeTemplate, { agentId: "historian2" }),
      };
      for (const [agentId, channel] of [
        ["main", "MAIN"],
        ["historian2", "HISTORIAN"],
      ] as const) {
        await replaceSessionEntry(
          {
            agentId,
            storePath: resolveSessionStorePathCore(storeTemplate, { agentId }),
            sessionKey: "global",
          },
          {
            sessionId: `${agentId}-session`,
            updatedAt: Date.now(),
            delivery: normalizeSessionDeliveryState({
              context: { channel: "slack", to: `channel:${channel}` },
            }),
          },
        );
      }
      const mainStoreBefore = readSessionStoreForTest(mainStorePath);
      replySpy.mockResolvedValue({ text: "needs attention" });
      const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "HISTORIAN" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "historian2",
        deps: {
          getReplyFromConfig: replySpy,
          slack: sendSlack,
          getQueueSize: () => 0,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        AgentId: "historian2",
        SessionKey: "agent:historian2:global:heartbeat",
      });
      expect(getReplySystemEventContext(replySpy.mock.calls[0]?.[1])).toMatchObject({
        heartbeatEventQueueSessionKey: "agent:historian2:global",
      });
      expect(sendSlack).toHaveBeenCalledWith(
        "channel:HISTORIAN",
        "needs attention",
        expect.objectContaining({ identity: { name: "Pulse", emoji: "📟" } }),
      );
      expect(readSessionStoreForTest(mainStorePath)).toEqual(mainStoreBefore);
      const historianStore = Object.fromEntries(
        listSessionEntriesReadOnly(historianScope).map(({ sessionKey, entry }) => [
          sessionKey,
          entry,
        ]),
      );
      expect(historianStore.global).toBeDefined();
      expect(historianStore["agent:historian2:global:heartbeat"]).toBeDefined();
      expect(sendSlack).toHaveBeenCalledOnce();
    });
  });

  it.each([false, true])(
    "preserves the queue of a session named heartbeat with isolation %s",
    async (isolatedSession) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "none", session: "heartbeat", isolatedSession },
            },
          },
          session: { store: storePath },
        };
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        const result = await runHeartbeatOnce({
          cfg,
          deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
        });

        expect(result.status).toBe("ran");
        expect(replySpy).toHaveBeenCalledOnce();
        const [context, options] = replySpy.mock.calls[0]!;
        expect(context.SessionKey).toBe(
          isolatedSession ? "agent:main:heartbeat:heartbeat" : "agent:main:heartbeat",
        );
        expect(getReplySystemEventContext(options)).toMatchObject({
          heartbeatEventQueueSessionKey: "agent:main:heartbeat",
        });
      });
    },
  );

  it("keeps a global hook event owned by another agent queued for its owner", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: tmpDir },
          entries: { main: {}, alpha: {}, beta: {} },
        },
        session: { scope: "global", store: storeTemplate },
      };
      for (const agentId of ["alpha", "beta"]) {
        await seedSessionStore(
          resolveSessionStorePathCore(storeTemplate, { agentId }),
          "global",
          {},
        );
        enqueueSystemEvent(
          `Hook ${agentId}: done`,
          withSystemEventOwner({ sessionKey: "global" }, agentId),
        );
      }
      const systemEventBlocks = mockReplyWithSystemEvents(replySpy, cfg);

      const run = (agentId: string) =>
        runHeartbeatOnce({
          cfg,
          agentId,
          source: "hook",
          intent: "immediate",
          reason: "hook:wake",
          deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
        });
      for (const [index, agentId] of ["alpha", "beta"].entries()) {
        expect((await run(agentId)).status).toBe("ran");
        expect(replySpy).toHaveBeenCalledTimes(index + 1);
        expect(replySpy.mock.calls[index]?.[0]).toMatchObject({
          AgentId: agentId,
          SessionKey: "global",
        });
        expect(systemEventBlocks[index]).toContain(`Hook ${agentId}: done`);
        expect(systemEventBlocks[index]).not.toContain(
          `Hook ${agentId === "alpha" ? "beta" : "alpha"}: done`,
        );
        expect(peekSystemEventEntries(`agent:${agentId}:global`)).toEqual([]);
        if (agentId === "alpha") {
          expect(peekSystemEventEntries("agent:beta:global").map((event) => event.text)).toEqual([
            "Hook beta: done",
          ]);
        }
      }
    });
  });
});

describe("runHeartbeatOnce", () => {
  it("uses the delivery target as sender when lastTo differs", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "slack",
                to: "C0A9P2N8QHY",
              },
            },
          },
          session: { store: storePath },
        };

        await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "1644620762",
        });

        replySpy.mockImplementation(async (ctx: { To?: string; From?: string }) => {
          expect(ctx.To).toBe("C0A9P2N8QHY");
          expect(ctx.From).toBe("C0A9P2N8QHY");
          return { text: "ok" };
        });

        const sendSlack = vi.fn().mockResolvedValue({
          messageId: "m1",
          channelId: "C0A9P2N8QHY",
        });

        await runHeartbeatOnce({
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            slack: sendSlack,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(sendSlack).toHaveBeenCalled();
      },
      { prefix: "openclaw-hb-" },
    );
  });
});
