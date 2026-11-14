import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { bindRequesterProfile } from "../requester-profile.js";
import { runReplyAgent } from "./agent-runner-run.js";
import {
  executeQueuedFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import type { runPreparedReply } from "./get-reply-run.js";
import {
  createPreparedReplyTurn as turn,
  createProviderSurface,
  ownerParams,
} from "./get-reply-run.test-support.js";
import { enqueueFollowupRun, scheduleFollowupDrain, type FollowupRun } from "./queue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

type ReplyRunParams = Parameters<typeof runPreparedReply>[0];

export function createOwnerIngress(kind: string, channel: string, body: string, runId: string) {
  const params = ownerParams();
  params.command.senderId = "owner-1";
  params.command.senderIsOwner = kind !== "non-owner" && kind !== "discord-promoted-before-drain";
  return {
    ...params,
    ...turn(body, {
      ...createProviderSurface(channel),
      ChatType: "group",
      SenderId:
        kind === "owner-alias" || kind === "discord-owner-alias" ? "transport-alias" : "owner-1",
      InboundEventKind: kind === "room-event" ? "room_event" : undefined,
      InputProvenance:
        kind === "internal" || kind === "inter-session"
          ? { kind: "inter_session" as const, sourceTool: "sessions_send" }
          : undefined,
    }),
    conversation: undefined,
    sessionEntry:
      kind === "spawned"
        ? { sessionId: "spawned-session", updatedAt: 1, spawnedBy: "agent:parent:main" }
        : undefined,
    opts: { runId, suppressNextUserMessagePersistence: kind === "replay" },
  };
}

export function registerQueuedPersonalReminderCase({
  runPrepared,
}: {
  runPrepared: (overrides?: Partial<ReplyRunParams>) => ReturnType<typeof runPreparedReply>;
}): void {
  it("preserves each linked Telegram requester's reminder authority through queue admission", async () => {
    resetFollowupTurnTestState();
    const key = "agent:default:telegram:group:shared:topic:7";
    const cfg = { session: {}, channels: {}, agents: { defaults: {} } };
    const queuedSources: FollowupRun[] = [];
    const observed: Array<{
      profileId: string;
      sessionKey: string;
      to: string;
      threadId?: string | number;
    }> = [];
    const errors: unknown[] = [];
    const previousRunReplyAgent = vi.mocked(runReplyAgent).getMockImplementation();
    setRuntimeConfigSnapshot(cfg);
    vi.mocked(runReplyAgent).mockImplementation(async ({ followupRun }) => {
      const source = { ...followupRun, controllerInput: undefined, controllerClaim: undefined };
      expect(
        enqueueFollowupRun(
          key,
          source,
          {
            mode: "collect",
            debounceMs: 0,
            cap: 20,
            dropPolicy: "summarize",
          },
          "none",
          undefined,
          false,
        ),
      ).toBe(true);
      queuedSources.push(source);
      return undefined;
    });
    getFollowupTurnTestState().execute.mockImplementation(async (params) => {
      const reminder = expectDefined(
        params.opts?.cronCreatorAuthorityCapability?.personalReminder,
        "queued reminder source",
      );
      observed.push({
        profileId: reminder.profileId,
        sessionKey: reminder.sessionKey,
        to: reminder.to,
        threadId: reminder.threadId,
      });
      return {
        runId: params.opts?.runId ?? "queued",
        outcome: { kind: "rejected", payload: { text: "done" } },
      };
    });
    try {
      for (const human of ["alice", "bob"]) {
        const profileId = `profile-${human}`;
        const params = createOwnerIngress(
          "non-owner",
          "telegram",
          `remind ${human}`,
          `ingress-${human}`,
        );
        params.command.senderId = human;
        const source = turn(
          `remind ${human}`,
          {
            ...createProviderSurface("telegram"),
            OriginatingChannel: "telegram",
            OriginatingTo: "shared",
            ChatType: "group",
            SenderId: human,
            AccountId: "default",
            MessageThreadId: 7,
            SessionKey: key,
          },
          {},
          { InboundAccessAuthorized: true },
        );
        bindRequesterProfile(source.ctx, {
          id: profileId,
          displayName: human,
          isCurrent: () => true,
        });
        const operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId,
          scopes: ["operator.write"],
          assertCurrent: () => {},
        });
        await runPrepared({
          ...params,
          ...source,
          cfg,
          sessionKey: key,
          opts: { runId: `ingress-${human}`, operatorAuthority },
        });
      }
      expect(queuedSources).toHaveLength(2);
      await replaceSessionEntry(
        { agentId: "default", sessionKey: key, storePath: resolveSessionStorePathCore() },
        { sessionId: queuedSources[0]!.run.sessionId, updatedAt: 1 },
      );
      scheduleFollowupDrain(key, async (queued) => {
        try {
          await executeQueuedFollowupTurnForTest(queued, {
            runId: `queued-${observed.length}`,
            admit: true,
          });
        } catch (error) {
          errors.push(error);
        }
      });
      await Promise.all(
        queuedSources.map(
          (source) => expectDefined(source.controllerInput, "queued source").settlement.promise,
        ),
      );
      await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined(), {
        timeout: 10_000,
      });
      expect(errors).toEqual([]);
      expect(observed).toEqual([
        { profileId: "profile-alice", sessionKey: key, to: "shared", threadId: 7 },
        { profileId: "profile-bob", sessionKey: key, to: "shared", threadId: 7 },
      ]);
    } finally {
      if (previousRunReplyAgent) {
        vi.mocked(runReplyAgent).mockImplementation(previousRunReplyAgent);
      } else {
        vi.mocked(runReplyAgent).mockReset();
      }
      clearFollowupQueue(key);
      clearRuntimeConfigSnapshot();
    }
  });
}
