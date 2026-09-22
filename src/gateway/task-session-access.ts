import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isConfiguredSessionStoreAgentId } from "../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { GatewayAccessReadScope } from "./gateway-access-revision.js";
import { hasOperatorBoundary } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
  resolveSessionSharingTargets,
} from "./session-sharing.js";

export function resolveTaskRequesterSessionTarget(
  task: Pick<TaskRecord, "ownerKey" | "requesterAgentId" | "requesterSessionKey">,
): { sessionKey: string; agentId?: string } | undefined {
  const sessionKey = normalizeOptionalString(task.requesterSessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const agentId =
    normalizeOptionalString(task.requesterAgentId) ??
    parseAgentSessionKey(sessionKey)?.agentId ??
    parseAgentSessionKey(task.ownerKey)?.agentId;
  return { sessionKey, ...(agentId ? { agentId } : {}) };
}

export function canAccessTaskRequesterSession(params: {
  access?: "read" | "write";
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  task: Pick<TaskRecord, "ownerKey" | "requesterAgentId" | "requesterSessionKey">;
}): boolean {
  const target = resolveTaskRequesterSessionTarget(params.task);
  if (!target || isGatewayAdmin(params.client)) {
    return true;
  }
  return canAccessResolvedTaskSession(
    params,
    target,
    resolveSessionSharingTarget({ cfg: params.cfg, ...target }),
  );
}

function canAccessResolvedTaskSession(
  params: Pick<Parameters<typeof canAccessTaskRequesterSession>[0], "cfg" | "client" | "access">,
  target: ReturnType<typeof resolveTaskRequesterSessionTarget>,
  sharingTarget: SessionSharingTarget | null,
): boolean {
  if (!target || isGatewayAdmin(params.client)) {
    return true;
  }
  if (
    authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: target.sessionKey,
      target: sharingTarget,
    })
  ) {
    return false;
  }
  if (!hasOperatorBoundary(params.client, params.cfg)) {
    return true;
  }
  if (!sharingTarget) {
    return false;
  }
  if (params.access === "write") {
    return !authorizeSessionSharingTarget({
      cfg: params.cfg,
      client: params.client,
      target: sharingTarget,
    });
  }
  const visibilityFilter = createSessionListEntryFilter({
    cfg: params.cfg,
    client: params.client,
  });
  return visibilityFilter?.(sharingTarget.storeKey, sharingTarget.entry) ?? true;
}

/** Prepare only this slice's entries; the registry drops this filter before yielding. */
export function prepareTaskSessionReadFilter(
  params: { cfg: OpenClawConfig; client: GatewayClient | null },
  tasks: readonly Readonly<TaskRecord>[],
  accessRead: GatewayAccessReadScope,
): (task: Readonly<TaskRecord>) => boolean {
  if (isGatewayAdmin(params.client)) {
    return (task) => canAccessTaskRequesterSession({ ...params, task });
  }
  const requests: Array<{
    task: Readonly<TaskRecord>;
    target: ReturnType<typeof resolveTaskRequesterSessionTarget>;
    sharingTarget: SessionSharingTarget | null;
  }> = tasks.map((task) => ({
    task,
    target: resolveTaskRequesterSessionTarget(task),
    sharingTarget: null,
  }));
  const lookups = requests.flatMap((request) =>
    request.target ? [{ request, target: request.target }] : [],
  );
  for (const [index, sharingTarget] of resolveSessionSharingTargets({
    cfg: params.cfg,
    targets: lookups.map((lookup) => lookup.target),
    onLookupTarget: (resolved, lookupIndex) => {
      const requested = expectDefined(lookups[lookupIndex], "prepared task session lookup").target;
      if (
        requested.sessionKey !== resolved.canonicalKey ||
        !parseAgentSessionKey(resolved.canonicalKey) ||
        !isConfiguredSessionStoreAgentId(params.cfg, resolved.agentId)
      ) {
        accessRead.dependOnAllSessionIdentities();
      } else {
        // Missing and denied targets still affect ordering. Any physical store
        // creating a matching key can invalidate the lookup's uniqueness.
        accessRead.dependOnSessionKeys(resolved.storeKeys);
      }
    },
  }).entries()) {
    expectDefined(lookups[index], "prepared task session lookup").request.sharingTarget =
      sharingTarget;
  }
  const prepared = new Map(requests.map((request) => [request.task, request]));
  return (task) => {
    const request = expectDefined(
      prepared.get(task),
      "task belongs to the synchronous access slice",
    );
    return canAccessResolvedTaskSession(params, request.target, request.sharingTarget);
  };
}
