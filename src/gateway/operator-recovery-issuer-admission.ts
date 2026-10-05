import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { readOperatorModelPolicyCeilings } from "../agents/operator-model-policy.js";
import type {
  GoalRecoveryIssuerAdmission,
  TurnRecoveryIssuerAdmission,
} from "../config/sessions/main-session-recovery.types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";

/** Accepted turn custody never constructs a goal or borrows attribution as authority. */
export function captureGatewayTurnIssuerAdmission(params: {
  authority: AdmittedRunOperatorAuthority | undefined;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  runId: string;
  assertCurrent?: () => void;
}): TurnRecoveryIssuerAdmission | undefined {
  const original = captureGatewayRestartIssuerAdmission(params);
  if (!original) {
    return undefined;
  }
  return {
    assertCurrent: original.assertCurrent,
    capture: (entry, input) => {
      return {
        ...original.capture(entry),
        ...input,
        runId: params.runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        repositoryWorkspaceId: entry.repositoryWorkspaceId,
      };
    },
  };
}

export function captureGatewayGoalIssuerAdmission(params: {
  authority: AdmittedRunOperatorAuthority | undefined;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  assertCurrent?: () => void;
}): GoalRecoveryIssuerAdmission | undefined {
  const original = captureGatewayRestartIssuerAdmission(params);
  return (
    original && {
      assertCurrent: original.assertCurrent,
      capture: (entry, goal) => ({ ...original.capture(entry), goalId: goal.id }),
    }
  );
}

function captureGatewayRestartIssuerAdmission(params: {
  authority: AdmittedRunOperatorAuthority | undefined;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  assertCurrent?: () => void;
}) {
  const authority = params.authority;
  if (!authority) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  const assertCurrent = () => {
    params.assertCurrent?.();
    authority.assertCurrent();
  };
  assertCurrent();
  if (!authority.captureRestartRecoveryIssuer?.()) {
    return undefined;
  }
  return {
    assertCurrent,
    capture: (entry: { sessionId: string; lifecycleRevision?: string }) => {
      assertCurrent();
      if (
        entry.sessionId !== params.sessionId ||
        entry.lifecycleRevision !== params.lifecycleRevision
      ) {
        throw new Error("Goal issuer session lifecycle changed before admission");
      }
      const issuer = authority.captureRestartRecoveryIssuer?.();
      const ceilings = readOperatorModelPolicyCeilings(authority.modelPolicy);
      if (!issuer || !ceilings) {
        throw new Error("Original goal issuer is unavailable");
      }
      return {
        sessionId: entry.sessionId,
        sessionKey: params.sessionKey,
        lifecycleRevision: entry.lifecycleRevision,
        issuer: { ...issuer, scopes: [...authority.scopes], modelCeilings: ceilings },
      };
    },
  };
}
