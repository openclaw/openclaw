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
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedSessionStore,
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

function runIdentity(
  cfg: OpenClawConfig,
  replySpy: HeartbeatReplySpy,
  options: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps"> = {},
  deps: Partial<HeartbeatDeps> = {},
) {
  return runHeartbeatOnce({
    cfg,
    ...options,
    deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, ...deps },
  });
}

function identityConfig(
  workspace: string,
  store: string,
  heartbeat?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["heartbeat"],
  session: OpenClawConfig["session"] = {},
): OpenClawConfig {
  return { agents: { defaults: { workspace, heartbeat } }, session: { store, ...session } };
}

describe("runHeartbeatOnce identity", () => {
  afterEach(() => resetSystemEventsForTest());

  it("keeps isolated global delivery and identity in the selected agent store", () =>
    withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
      const cfg = identityConfig(
        tmpDir,
        storeTemplate,
        { every: "5m", target: "last", isolatedSession: true },
        { scope: "global", dmScope: "per-channel-peer" },
      );
      cfg.agents!.entries = {
        main: {},
        historian2: { identity: { name: "Pulse", emoji: "📟" } },
      };
      const scope = (agentId: string) => ({
        agentId,
        storePath: resolveSessionStorePathCore(storeTemplate, { agentId }),
      });
      const mainStorePath = scope("main").storePath;
      for (const [agentId, channel] of [
        ["main", "MAIN"],
        ["historian2", "HISTORIAN"],
      ] as const) {
        await replaceSessionEntry(
          { ...scope(agentId), sessionKey: "global" },
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

      await expect(
        runIdentity(cfg, replySpy, { agentId: "historian2" }, { slack: sendSlack }),
      ).resolves.toMatchObject({ status: "ran" });
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
      expect(listSessionEntriesReadOnly(scope("historian2"))).toEqual(
        expect.arrayContaining(
          ["global", "agent:historian2:global:heartbeat"].map((sessionKey) =>
            expect.objectContaining({ sessionKey, entry: expect.anything() }),
          ),
        ),
      );
      expect(sendSlack).toHaveBeenCalledOnce();
    }));

  it.each([false, true])(
    "preserves the queue of a session named heartbeat with isolation %s",
    (isolatedSession) =>
      withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg = identityConfig(tmpDir, storePath, {
          every: "5m",
          target: "none",
          session: "heartbeat",
          isolatedSession,
        });
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        await expect(runIdentity(cfg, replySpy)).resolves.toMatchObject({ status: "ran" });
        expect(replySpy).toHaveBeenCalledOnce();
        const [context, options] = replySpy.mock.calls[0]!;
        expect(context.SessionKey).toBe(
          isolatedSession ? "agent:main:heartbeat:heartbeat" : "agent:main:heartbeat",
        );
        expect(getReplySystemEventContext(options)).toMatchObject({
          heartbeatEventQueueSessionKey: "agent:main:heartbeat",
        });
      }),
  );

  it("keeps a global hook event owned by another agent queued for its owner", () =>
    withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
      const cfg = identityConfig(tmpDir, storeTemplate, undefined, { scope: "global" });
      cfg.agents!.entries = { main: {}, alpha: {}, beta: {} };
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
      const systemEventBlocks: Array<string | undefined> = [];
      replySpy.mockImplementation(async (ctx, opts) => {
        const eventContext = getReplySystemEventContext(opts);
        const sessionKey = eventContext?.sessionKey ?? ctx.SessionKey;
        if (!ctx.AgentId || !sessionKey) {
          throw new Error("Expected heartbeat agent and session context");
        }
        systemEventBlocks.push(
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

      const run = (agentId: string) =>
        runIdentity(cfg, replySpy, {
          agentId,
          source: "hook",
          intent: "immediate",
          reason: "hook:wake",
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
    }));
});
