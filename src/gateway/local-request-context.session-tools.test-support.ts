import { steerActiveSessionWithOptionalDeliveryWait } from "../agents/embedded-agent-runner/run/attempt-queue-message.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { persistAgentSessionMessage } from "../agents/sessions/agent-session-transcript.js";
import { registerQueuedUserMessageRetirement } from "../agents/sessions/queued-user-message-retirement.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { setSteeringMessageIdentity } from "../agents/sessions/steering-message-identity.js";
import { withoutGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { attachRuntimeUserTurnTranscriptContext } from "../sessions/user-turn-transcript-runtime-context.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

export const REQUESTER = "agent:main:dashboard:session-tools-requester";
export const TARGET = "agent:main:dashboard:session-tools-target";
export const TARGET_ID = "session-tools-target-id";
export const INCOGNITO = "agent:main:dashboard:incognito-session-tools";
export const PARTICIPANT_SHARED = "agent:main:dashboard:participant-shared";
export const PARTICIPANT_DRAFT = "agent:main:dashboard:participant-draft";
export const PARTICIPANT_DRAFT_ID = "participant-draft-id";
let fixtureRun: Promise<void> | undefined;

export async function seedSessionToolsFixtureSession({
  agentId = "main",
  sessionKey,
  sessionId,
  creatorId = "other-person",
}: {
  agentId?: string;
  sessionKey: string;
  sessionId: string;
  creatorId?: string;
}) {
  await upsertSessionEntryCore(
    { agentId, sessionKey },
    {
      sessionId,
      updatedAt: 1,
      visibility: "shared",
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: creatorId },
    },
  );
  return { sessionKey, sessionId };
}

export function withSessionToolsFixture(run: (cfg: OpenClawConfig) => Promise<void>) {
  return (fixtureRun = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: state.workspaceDir },
          other: { workspace: state.path("other-workspace") },
        },
      },
      tools: { sessions: { visibility: "all" } },
    };
    await state.writeConfig(cfg);
    for (const [agentId, sessionKey, sessionId] of [
      ["main", REQUESTER, "session-tools-requester-id"],
      ["main", TARGET, TARGET_ID],
      ["main", INCOGNITO, "session-tools-incognito-id"],
      ["other", "agent:other:dashboard:session-tools-other", "session-tools-other-id"],
    ] as const) {
      await seedSessionToolsFixtureSession({ agentId, sessionKey, sessionId });
    }
    const resources = new LegacyPluginSdkResourceHost();
    try {
      await resources.run(() =>
        withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, () =>
          run(cfg),
        ),
      );
    } finally {
      await resources.close();
    }
  }));
}

export function withParticipantSessionToolsFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    turn: Parameters<Parameters<typeof withPersonalToolTurn>[1]>[0];
    alice: Parameters<typeof withPersonalToolTurn>[0]["owner"];
    bob: Parameters<typeof withPersonalToolTurn>[0]["owner"];
  }) => Promise<void>,
) {
  return withSessionToolsFixture(async (cfg) => {
    const person = (name: string) => {
      const client = roleClient("write", `${name.toLowerCase()}-participant`);
      const profileId = client.authenticatedUserProfile?.profileId;
      if (!profileId) {
        throw new Error("expected participant profile");
      }
      return {
        profileId,
        senderId: `${name.toLowerCase()}-sender`,
        name,
        readCurrentRoleAssignment: () => "write",
      };
    };
    const alice = person("Alice");
    const bob = person("Bob");
    for (const [sessionKey, sessionId, visibility, marker] of [
      [PARTICIPANT_DRAFT, PARTICIPANT_DRAFT_ID, "draft", "Alice's distinctive draft marker"],
      [PARTICIPANT_SHARED, "participant-shared-id", "shared", "Shared participant marker"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          visibility,
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: alice.profileId },
        },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId },
        { message: { role: "user", content: marker } },
      );
    }
    await withPersonalToolTurn(
      { owner: alice, sessionKey: REQUESTER, sessionId: "session-tools-requester-id" },
      async (turn) => {
        const runId = turn.runtimeIdentity.operationalRunInstance.runId;
        registerAgentRunContext(runId, {
          agentId: "main",
          sessionKey: REQUESTER,
          sessionId: "session-tools-requester-id",
        });
        try {
          await run({ cfg, turn, alice, bob });
        } finally {
          clearAgentRunContext(runId);
        }
      },
    );
  });
}

export async function drainSessionToolsFixture() {
  // Failed test callbacks can still hold isolated state; join cleanup before the next fixture.
  await fixtureRun?.catch(() => {});
  fixtureRun = undefined;
}

export async function withDelayedSessionToolsSteering(
  cfg: OpenClawConfig,
  run: (receiver: {
    commit: () => Promise<void>;
    cancel: () => Promise<void>;
    pendingCount: () => number;
    end: () => void;
    abort: () => boolean;
    replace: () => void;
  }) => Promise<void>,
  options?: { reportSettlement?: boolean },
) {
  const target = {
    agentId: "main",
    sessionKey: PARTICIPANT_SHARED,
    sessionId: "participant-shared-id",
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
  };
  const manager = guardSessionManager(await SessionManager.openAsync(target), {
    ...target,
    config: cfg,
    runId: "participant-steering-target",
  });
  const queued: Array<{
    message: PersistedUserTurnMessage;
    recorder: UserTurnTranscriptRecorder;
  }> = [];
  const listeners = new Set<(event: unknown) => void>();
  const settled = createDeferredCore();
  const emit = (event: unknown) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  const session: Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[0] = {
    agent: {
      cancelSteeringMessage: (predicate) => {
        const index = queued.findIndex((entry) => predicate(entry.message));
        return index < 0 ? undefined : queued.splice(index, 1)[0]?.message;
      },
    },
    steer: async (text, _images, recorder, _media, _order, identity, canInject) => {
      const prepared = await recorder?.resolveMessage();
      if (!recorder || !prepared) {
        throw new Error("Expected sessions_send transcript input");
      }
      if (canInject && !canInject()) {
        throw new Error("Steering receiver is no longer current");
      }
      const message = attachRuntimeUserTurnTranscriptContext(
        { role: "user", content: text, timestamp: 1 },
        { message: prepared, recorder },
      );
      setSteeringMessageIdentity(message, identity);
      registerQueuedUserMessageRetirement(message, () => true);
      queued.push({ message, recorder });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        settled.resolve();
      };
    },
  };
  const handle = createEmbeddedRunHandle({
    runId: "participant-steering-target",
    supportsTranscriptCommitWait: true,
  });
  handle.messageInjectionV2 = {
    version: 2,
    isAvailable: () => true,
    queueMessage: (text, queueOptions, assertCurrent) =>
      steerActiveSessionWithOptionalDeliveryWait(
        session,
        text,
        options?.reportSettlement === false
          ? { ...queueOptions, onQueueSettled: undefined }
          : queueOptions,
        target.sessionKey,
        () => {
          assertCurrent();
          return true;
        },
      ),
  };
  withoutGatewayToolCallerIdentity(() =>
    setActiveEmbeddedRun(target.sessionId, handle, target.sessionKey, undefined, target.agentId),
  );
  const cancel = async () => {
    if (listeners.size === 0) {
      return;
    }
    emit({ type: "agent_settled" });
    await settled.promise;
  };
  let replacement: ReturnType<typeof createEmbeddedRunHandle> | undefined;
  try {
    await run({
      pendingCount: () => queued.length,
      cancel,
      end: () => clearActiveEmbeddedRun(target.sessionId, handle, target.sessionKey),
      abort: () => abortEmbeddedAgentRun(target.sessionId),
      replace: () => {
        const next = createEmbeddedRunHandle({ runId: "participant-steering-replacement" });
        replacement = next;
        withoutGatewayToolCallerIdentity(() =>
          setActiveEmbeddedRun(target.sessionId, next, target.sessionKey),
        );
      },
      commit: async () => {
        const entry = queued[0];
        if (!entry) {
          throw new Error("Expected an accepted steering message");
        }
        await persistAgentSessionMessage(manager, entry.message, {
          invalidateSerializedPrefixCache: true,
        });
        await entry.recorder.waitForRuntimePersistence();
        queued.shift();
        emit({ type: "message_end", message: entry.message });
        await settled.promise;
      },
    });
  } finally {
    await cancel();
    clearActiveEmbeddedRun(target.sessionId, handle, target.sessionKey);
    if (replacement) {
      clearActiveEmbeddedRun(target.sessionId, replacement, target.sessionKey);
    }
  }
}
