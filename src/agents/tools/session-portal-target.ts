import { getSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import { captureSessionPortalTarget } from "../../gateway/worker-environments/session-portal-target.js";
import {
  assertGatewayOwnerToolAuthority,
  resolveGatewayOwnerOnlyToolDenylist,
} from "../../security/dangerous-tools.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  bindCronManagementGrant,
  bindCronRequesterGrant,
} from "../cron-creator-authority-context.js";
import { AUTOMATIONS_TOOL_NAME } from "./automations-tool-name.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

export type SessionPortalToolTarget = {
  sessionKey: string;
  agentId: string;
  environmentId: string;
  assertCurrent(): void;
};

export function prepareSessionPortalToolAccess(input: {
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  senderIsOwner?: boolean;
  pluginExecutionAuthority?: AdmittedRunOperatorAuthority;
  isTurnTainted?: () => boolean;
  sandboxed: boolean;
  runId?: string;
  cronSelfRemoveOnlyJobId?: string;
}) {
  const cronCreatorAuthorityResolver = bindActiveCronCreatorAuthorityResolver(input.runId);
  // A scheduled run gets its self-scoped tool, not sender/administrator authority.
  // The tool action scope and Gateway admission still validate the current job.
  const hasAutomationGrant = Boolean(
    input.cronSelfRemoveOnlyJobId ||
    cronCreatorAuthorityResolver ||
    bindCronRequesterGrant(input.runId) ||
    bindCronManagementGrant(input.runId),
  );
  const sessionPortalTarget =
    input.senderIsOwner === false && !input.sandboxed
      ? prepareSessionPortalToolTarget(input)
      : undefined;
  // Sessions owns its assignment/control action gates; portal and automation
  // remain scoped exceptions. Other control-plane tools require owner authority.
  const operatorAuthority = input.pluginExecutionAuthority;
  // These tools already own narrower live authorization. The retained-admin
  // projection must not replace their scoped RPC or captured-target checks.
  const hasIndependentAuthority = (name: string) =>
    name === "sessions" ||
    (name === "portal" && sessionPortalTarget !== undefined) ||
    (name === AUTOMATIONS_TOOL_NAME && hasAutomationGrant);
  const ownerOnlyCoreToolDenylist = resolveGatewayOwnerOnlyToolDenylist(
    input.senderIsOwner,
    operatorAuthority,
    input.isTurnTainted?.(),
  ).filter((name) => !hasIndependentAuthority(name));
  return {
    sessionPortalTarget,
    ownerOnlyCoreToolDenylist,
    ownerToolCurrentAssertion: operatorAuthority
      ? (toolName: string) =>
          hasIndependentAuthority(toolName)
            ? undefined
            : () =>
                assertGatewayOwnerToolAuthority(
                  toolName,
                  input.senderIsOwner,
                  operatorAuthority,
                  input.isTurnTainted?.(),
                )
      : undefined,
    cronCreatorAuthorityResolver,
  };
}

/** Availability uses resident execution facts; the scoped RPC still authorizes every call. */
export function prepareSessionPortalToolTarget(input: {
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
}): SessionPortalToolTarget | undefined {
  if (!input.sessionId || !input.sessionKey || !input.agentId) {
    return undefined;
  }
  const context = getInProcessGatewayToolContext();
  const environments = context?.workerEnvironmentService;
  const projection = getSessionRowProjection(context);
  const query = { agentId: input.agentId, key: input.sessionKey };
  const readCurrentTarget = () => {
    const row = projection?.capture(query);
    const state = projection?.sharingTargetState(query);
    if (
      !row?.storedEntry ||
      row.unresolvedDatabaseFacts ||
      !projection?.isCurrent(row) ||
      state?.status !== "ready" ||
      state.target.generation !== row.generation ||
      state.target.agentId !== row.agentId ||
      state.target.canonicalKey !== row.key ||
      state.target.storePath !== row.storeTarget.storePath ||
      state.target.entry.sessionId !== row.storedEntry.sessionId ||
      state.target.entry.lifecycleRevision !== row.storedEntry.lifecycleRevision ||
      row.storedEntry.modelSelectionLocked === true
    ) {
      return undefined;
    }
    return state.target;
  };
  const row = readCurrentTarget();
  const generation = row?.generation;
  const record = row && {
    agentId: row.agentId,
    sessionKey: row.canonicalKey,
    sessionId: row.entry.sessionId,
    sessionLifecycleRevision: row.entry.lifecycleRevision,
  };
  if (
    !context?.portalService ||
    !environments ||
    !record ||
    record.sessionKey !== input.sessionKey ||
    record.agentId !== input.agentId ||
    record.sessionId !== input.sessionId
  ) {
    return undefined;
  }
  try {
    const target = captureSessionPortalTarget(environments, record);
    return {
      sessionKey: record.sessionKey,
      agentId: record.agentId,
      environmentId: target.binding.environmentId,
      assertCurrent: () => {
        if (getInProcessGatewayToolContext() !== context) {
          throw new Error("Session preview belongs to a different or retired Gateway");
        }
        const current = readCurrentTarget();
        if (
          !current ||
          current.generation !== generation ||
          current.entry.sessionId !== record.sessionId ||
          current.entry.lifecycleRevision !== record.sessionLifecycleRevision
        ) {
          throw new Error("Conversation preview policy or session identity changed");
        }
        target.assertCurrent();
      },
    };
  } catch {
    return undefined;
  }
}
