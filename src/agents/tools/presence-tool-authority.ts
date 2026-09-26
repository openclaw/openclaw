import { readOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import type { AgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  getAdmittedRunSource,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import type { bindActiveOperatorTurnAuthority } from "../cron-creator-authority-context.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

/** Capture the original source before the built-in adapter creates a System client. */
export function capturePresenceToolAuthority(options?: {
  runId?: string;
  ownerAuthority?: ReturnType<typeof bindActiveOperatorTurnAuthority>;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  delegatedAuthority?: AgentRunDelegatedAuthority;
  assertCurrent?: () => void;
}): () => void {
  const caller = getGatewayToolCallerIdentity();
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const inherited = readOperatorToolGatewayAuthority();
  const scope = getPluginRuntimeGatewayRequestScope();
  const operatorAuthority =
    options?.operatorAuthority ??
    caller?.operatorAuthority ??
    inherited?.operatorRunAuthority ??
    scope?.client?.internal?.operatorRunAuthority;
  const delegatedAuthority = options?.delegatedAuthority ?? caller?.approvalAuthority;
  const sourceScopes =
    operatorAuthority?.scopes ??
    inherited?.scopes ??
    (scope?.client
      ? scope.client.connect.role === "node"
        ? []
        : (scope.client.connect.scopes ?? [])
      : undefined);
  const ownerAuthority = options?.ownerAuthority;
  const ownerRunId = options?.runId;
  return () => {
    options?.assertCurrent?.();
    assertCallerCurrent?.();
    if (operatorAuthority) {
      assertAdmittedRunOperatorAuthority(operatorAuthority);
      operatorAuthority.assertCurrent();
    } else {
      inherited?.signal.throwIfAborted();
      inherited?.assertCurrent?.();
      scope?.signal?.throwIfAborted();
      if (scope?.hasCurrentClientAuthority?.() === false) {
        throw new Error("Gateway caller authority is no longer active.");
      }
    }
    if (sourceScopes !== undefined) {
      if (!operatorScopeSatisfied("operator.read", sourceScopes)) {
        throw new Error("Presence requires operator.read access.");
      }
      return;
    }
    // Owner and scheduler provenance require the same live admitted run; neither
    // tool availability nor an absent operator restriction establishes access.
    if (delegatedAuthority && (assertCallerCurrent || options?.assertCurrent)) {
      if (
        ownerAuthority &&
        ownerRunId &&
        delegatedAuthority.operationalRunInstance.runId === ownerRunId
      ) {
        ownerAuthority.assertActive();
        return;
      }
      if (getAdmittedRunSource(delegatedAuthority) === "operator-schedule") {
        return;
      }
    }
    throw new Error(
      "Presence requires authenticated Gateway read access or a trusted operator source.",
    );
  };
}
