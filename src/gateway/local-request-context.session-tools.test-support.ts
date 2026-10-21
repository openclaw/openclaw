import { expectDefined } from "@openclaw/normalization-core/expect";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { abortEmbeddedAgentRun } from "../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../agents/harness/tool-authority.runtime.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { persistAgentSessionMessage } from "../agents/sessions/agent-session-transcript.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session-types.js";
import { registerQueuedUserMessageRetirement } from "../agents/sessions/queued-user-message-retirement.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  reportSteeringMessagePersistenceFailure,
  setSteeringMessageIdentity,
} from "../agents/sessions/steering-message-identity.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import type { CliDeps } from "../cli/deps.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
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
  visibility = "shared",
}: {
  agentId?: string;
  sessionKey: string;
  sessionId: string;
  creatorId?: string;
  visibility?: "shared" | "draft";
}) {
  await upsertSessionEntryCore(
    { agentId, sessionKey },
    {
      sessionId,
      updatedAt: 1,
      visibility,
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: creatorId },
    },
  );
  return { sessionKey, sessionId };
}

export function withSessionToolsFixture(
  run: (cfg: OpenClawConfig) => Promise<void>,
  options?: { audit?: boolean },
) {
  return (fixtureRun = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      ...(options?.audit ? { logging: { audit: { enabled: true, executionIdentity: true } } } : {}),
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
    setRuntimeConfigSnapshot(cfg);
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
        withLocalGatewayRequestScope(
          { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
          async () => {
            // Fixture startup must finish before a tool's request deadline begins.
            await getPluginRuntimeGatewayRequestScope()?.context?.ensureSessionRowProjection?.();
            return run(cfg);
          },
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
  options?: { audit?: boolean },
) {
  return withSessionToolsFixture(async (cfg) => {
    const person = (name: string) => {
      const client = roleClient("write", `${name.toLowerCase()}-participant`);
      const { profileId } = expectDefined(client.authenticatedUserProfile, "participant profile");
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
      await seedSessionToolsFixtureSession({
        sessionKey,
        sessionId,
        visibility,
        creatorId: alice.profileId,
      });
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId },
        { message: { role: "user", content: marker } },
      );
    }
    await withPersonalToolTurn(
      {
        owner: alice,
        config: cfg,
        sessionKey: REQUESTER,
        sessionId: "session-tools-requester-id",
        allowCollaborativeSteering: true,
      },
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
  }, options);
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
    waitForAccepted: () => Promise<void>;
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
  const listeners = new Set<(event: AgentSessionEvent) => unknown>();
  const accepted = createDeferredCore();
  const settled = createDeferredCore();
  const emit = (event: AgentSessionEvent) => {
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
        {
          ...queueOptions,
          onQueueAccepted: (value) => {
            queueOptions?.onQueueAccepted?.(value);
            if (value) {
              accepted.resolve();
            }
          },
          ...(options?.reportSettlement === false ? { onQueueSettled: undefined } : {}),
        },
        target.sessionKey,
        () => {
          assertCurrent();
          return true;
        },
      ),
  };
  const cancel = async () => {
    if (listeners.size === 0) {
      return;
    }
    emit({ type: "agent_settled" });
    await settled.promise;
  };
  const settleReceiver = () => emit({ type: "agent_settled" });
  let replacement: ReturnType<typeof createEmbeddedRunHandle> | undefined;
  const source = getGatewayToolCallerIdentity();
  if (!source?.requesterOrigin || !source.operatorAuthority) {
    throw new Error("Expected the admitted personal-tool requester");
  }
  const runId = "participant-steering-target";
  const sessionFile = "/tmp/participant-shared.jsonl";
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    operatorAuthority: source.operatorAuthority,
    facts: {
      agentId: target.agentId,
      runId,
      ingress: { kind: "system", state: "present", boundary: "session-tools-steering-test" },
    },
  });
  try {
    await withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext: await admission.admit("embedded", "session-tools-steering-test") },
      {
        ...target,
        runId,
        sessionFile,
        workspaceDir: "/tmp/session-tools-steering-test",
        config: cfg,
        provider: "openai",
        modelId: "gpt-test",
        requesterOrigin: source.requesterOrigin,
      },
      undefined,
      async (prepared) => {
        handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
        registerTestEmbeddedRun(
          target.sessionId,
          handle,
          target.sessionKey,
          sessionFile,
          target.agentId,
        );
        await withGatewayToolCallerIdentity(source, () =>
          run({
            waitForAccepted: () => accepted.promise,
            pendingCount: () => queued.length,
            cancel,
            end: () => {
              settleReceiver();
              clearTestEmbeddedRun(target.sessionId, handle, target.sessionKey);
            },
            abort: () => {
              const aborted = abortEmbeddedAgentRun(target.sessionId);
              settleReceiver();
              if (aborted) {
                clearTestEmbeddedRun(target.sessionId, handle, target.sessionKey);
              }
              return aborted;
            },
            replace: () => {
              const next = createEmbeddedRunHandle({ runId: "participant-steering-replacement" });
              replacement = next;
              withoutGatewayToolCallerIdentity(() =>
                registerTestEmbeddedRun(target.sessionId, next, target.sessionKey),
              );
            },
            commit: async () => {
              const entry = expectDefined(queued.shift(), "Expected an accepted steering message");
              try {
                await persistAgentSessionMessage(manager, entry.message, {
                  invalidateSerializedPrefixCache: true,
                });
                await entry.recorder.waitForRuntimePersistence();
              } catch (error) {
                reportSteeringMessagePersistenceFailure(entry.message, error);
                throw error;
              }
              emit({ type: "message_end", message: entry.message });
              await settled.promise;
            },
          }),
        );
      },
    );
  } finally {
    await cancel();
    clearTestEmbeddedRun(target.sessionId, handle, target.sessionKey);
    if (replacement) {
      clearTestEmbeddedRun(target.sessionId, replacement, target.sessionKey);
    }
    admission.close();
  }
}
