import {
  getAgentToolExecutionContext,
  getAgentToolAssistantTurnId,
} from "../../../packages/agent-core/src/tool-execution-context.js";
import {
  captureMemoryExactSessionReader,
  assertMemoryExactReadSource,
} from "../../config/sessions/session-accessor.memory-exact-read.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { sameSessionTranscriptStorePath } from "../../config/sessions/transcript-store-identity.js";
import {
  sameSessionTranscriptStorageEnvironment,
  type CapturedSessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { WorkSnapshot } from "../../session-cards/progress-card-work-intent.js";
import type {
  ProgressOwner,
  AcceptedWaitReference,
} from "../../session-cards/progress-card-work.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";

export type ProgressWorkWaitBinding = {
  owner: ProgressOwner;
  target: CapturedSessionTranscriptTargetBinding;
  read(): WorkSnapshot;
  saved(snapshot: WorkSnapshot): void;
};

/** Capture before native admission awaits; only its accepting producer calls the receipt sink. */
export function captureProgressWorkWait() {
  const caller = getGatewayToolCallerIdentity();
  const binding = caller?.progressWork;
  const instance = caller?.operationalRunInstance;
  const invocation = getAgentToolExecutionContext();
  const turnId = getAgentToolAssistantTurnId();
  const assertCurrent = captureGatewayToolCallerAssertion();
  if (
    !binding ||
    !instance ||
    !invocation ||
    !turnId ||
    !assertCurrent ||
    caller.agentId !== binding.owner.agentId ||
    caller.sessionKey !== binding.owner.sessionKey
  ) {
    return undefined;
  }
  const memory = isIncognitoSessionKey(binding.owner.sessionKey)
    ? captureMemoryExactSessionReader(binding.target, assertCurrent)
    : undefined;
  const observed = binding.read();
  if (observed.kind !== "retained" || observed.state.record?.disposition.kind !== "actionable") {
    return undefined;
  }
  const expected = { generation: observed.state.generation, revision: observed.state.revision };
  const source = {
    runId: instance.runId,
    turnId,
    toolCallId: invocation.toolCall.id,
    processGeneration: getAgentRunLifecycleGeneration(),
  };
  return async (
    receipt: AcceptedWaitReference,
    requester?: CapturedSessionTranscriptTargetBinding & { lifecycleRevision: string | null },
  ) => {
    const isCaptured = () => {
      const current = binding.read();
      return (
        current.kind === "retained" &&
        current.state.generation === expected.generation &&
        current.state.revision === expected.revision
      );
    };
    try {
      assertCurrent();
      if (!isCaptured()) {
        return;
      }
      if (receipt.kind === "media") {
        if (
          !requester ||
          requester.agentId !== binding.owner.agentId ||
          requester.sessionKey !== binding.owner.sessionKey ||
          requester.sessionId !== binding.owner.sessionId ||
          requester.lifecycleRevision !== binding.owner.lifecycleRevision ||
          !sameSessionTranscriptStorageEnvironment(requester.env, binding.target.env)
        ) {
          return;
        }
        if (isIncognitoSessionKey(binding.owner.sessionKey)) {
          const requesterMemory = captureMemoryExactSessionReader(requester, assertCurrent);
          if (!memory?.source || !requesterMemory?.source) {
            return;
          }
          memory.assertCurrent();
          requesterMemory.assertCurrent();
          assertMemoryExactReadSource(memory.source, requesterMemory.source);
        } else if (
          !sameSessionTranscriptStorePath(
            (
              await prepareSqliteTargetFromSessionStorePath(requester.storePath, {
                agentId: requester.agentId,
                env: requester.env,
              })
            ).path,
            (
              await prepareSqliteTargetFromSessionStorePath(binding.target.storePath, {
                agentId: binding.owner.agentId,
                env: binding.target.env,
              })
            ).path,
          )
        ) {
          return;
        }
      }
      assertCurrent();
      if (!isCaptured()) {
        return;
      }
      const committed = await callAgentToolGatewayRequest<{ work: WorkSnapshot }>({
        method: "progressCard.reconcileWork",
        params: { sessionKey: binding.owner.sessionKey, agentId: binding.owner.agentId },
        agentToolCaller: {
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          assertCurrent,
          progressWork: {
            target: binding.target,
            owner: binding.owner,
            source,
            expected,
            acceptedWait: {
              receipt,
              resumeCondition: "Existing native owner returns the accepted result",
            },
          },
        },
        sessionMutationCommitGuard: assertCurrent,
      });
      assertCurrent();
      if (isCaptured()) {
        binding.saved(committed.work);
      }
    } catch {
      try {
        assertCurrent();
      } catch {
        return;
      }
      // Acceptance remains owned by the native producer even when CAS or acknowledgement fails.
      // Retain obligations, never invent a durable waiting receipt or retry the accepted effect.
      if (isCaptured()) {
        binding.saved({
          ...observed,
          coverage: {
            kind: "unavailable",
            reason: "Native handoff accepted; retained waiting persistence unavailable",
          },
        });
      }
    }
  };
}
