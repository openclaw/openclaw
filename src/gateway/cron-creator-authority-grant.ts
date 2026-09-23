import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { cloneCronRuntimeAuthority, type CronRuntimeAuthority } from "../cron/runtime-authority.js";
import {
  normalizeCronScheduledToolCallerOrigin,
  type CronScheduledToolCallerOrigin,
} from "../cron/scheduled-tool-policy.js";
import { normalizeCronAuthenticatedChannelRequester } from "../cron/tools-allow-provenance.js";
import {
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import type {
  CronAuthenticatedChannelRequester,
  CronCreatorAuthorityGrant,
} from "./cron-creator-authority-grant.types.js";

export const CRON_MANAGEMENT_METHODS = [
  "cron.list",
  "cron.get",
  "cron.update",
  "cron.run",
  "cron.remove",
] as const;
type CronManagementBinding = { method: string; authority: AgentRunDelegatedAuthority };
type CronManagementCaller = {
  operationalRunInstance: AgentRunDelegatedAuthority["operationalRunInstance"];
  delegatedAuthority: Pick<AgentRunDelegatedAuthority, "lifecycleGeneration" | "claimId">;
};
const activeManagement = new AsyncLocalStorage<{
  identity: CronManagementCaller;
  assertActive: () => void;
  callerOrigin?: CronScheduledToolCallerOrigin;
  channelRequester?: CronAuthenticatedChannelRequester;
}>();

/** Admission fact, independent of a run lifetime so an authorized yield can transfer it. */
export type CronManagementEntitlement =
  | Readonly<{ source: "control-ui-admin" }>
  | Readonly<{ source: "channel-owner"; isCurrent: () => boolean }>;

export type CronCreatorAuthorityRunScope = {
  readonly runId: string;
  readonly callerOrigin: CronScheduledToolCallerOrigin;
  readonly signal: AbortSignal;
  readonly grantTokens: Set<string>;
  readonly managementEntitlement?: CronManagementEntitlement;
  /** Separately admitted channel-owner identity, not implied by automation management rights. */
  readonly requesterOwner?: Readonly<{
    isCurrent: () => boolean;
    senderId?: string;
    channel?: string;
    accountId?: string;
  }>;
  /** Fresh admission only; never transferred with a management continuation. */
  readonly callerScopedCreation?: true;
  /** @deprecated Read managementEntitlement. Harness source compatibility lasts through 2026-10-12. */
  readonly controlUiAdmin?: true;
  readonly isCurrent?: () => boolean;
  active: boolean;
  abort: () => void;
};

type CronCreatorAuthorityGrantEntry = {
  scope: CronCreatorAuthorityRunScope;
  runtimeAuthority?: CronRuntimeAuthority;
  capturesRuntimeAuthority: boolean;
  isCurrent?: () => boolean;
  operationSignal?: AbortSignal;
  onOperationAbort?: () => void;
  management?: CronManagementBinding & { expiresAtMs: number };
};

const grantsByToken = new Map<string, CronCreatorAuthorityGrantEntry>();
const channelRequestersByScope = new WeakMap<
  CronCreatorAuthorityRunScope,
  CronAuthenticatedChannelRequester
>();

function expiredAuthorityError(): Error & { status: number } {
  return Object.assign(
    new TypeError(
      "Configured MCP cron authority is no longer active for this run. Retry the automation mutation from a fresh authenticated creator turn.",
    ),
    { name: "CronCreatorAuthorityExpiredError", status: 403 },
  );
}

export function createCronCreatorAuthorityRunScope(
  runId: string,
  callerOrigin: CronScheduledToolCallerOrigin = { kind: "unknown" },
  managementEntitlement?: CronManagementEntitlement,
  isCurrent?: () => boolean,
  channelRequester?: CronAuthenticatedChannelRequester,
  requesterOwner?: CronCreatorAuthorityRunScope["requesterOwner"],
  callerScopedCreation?: true,
): CronCreatorAuthorityRunScope {
  const abortController = new AbortController();
  const requester = normalizeCronAuthenticatedChannelRequester(channelRequester);
  const scope: CronCreatorAuthorityRunScope = {
    runId,
    callerOrigin: normalizeCronScheduledToolCallerOrigin(callerOrigin),
    signal: abortController.signal,
    grantTokens: new Set(),
    ...(managementEntitlement ? { managementEntitlement } : {}),
    ...(requesterOwner ? { requesterOwner } : {}),
    ...(callerScopedCreation ? { callerScopedCreation } : {}),
    get controlUiAdmin(): true | undefined {
      return managementEntitlement?.source === "control-ui-admin" ? true : undefined;
    },
    ...(isCurrent ? { isCurrent } : {}),
    active: true,
    abort: () => abortController.abort(expiredAuthorityError()),
  };
  if (requester) {
    channelRequestersByScope.set(scope, Object.freeze(requester));
  }
  return scope;
}

/** Keeps native identity out of the capability transported through harness contracts. */
export function hasCronChannelRequester(scope: CronCreatorAuthorityRunScope): boolean {
  return channelRequestersByScope.has(scope);
}

function hasCronAuthenticatedRequester(scope: CronCreatorAuthorityRunScope): boolean {
  return (
    scope.callerOrigin.kind === "local" ||
    hasCronChannelRequester(scope) ||
    scope.callerScopedCreation === true
  );
}

export function mintCronCreatorAuthorityGrant(
  scope: CronCreatorAuthorityRunScope,
  operationSignal?: AbortSignal,
  runtimeAuthority?: CronRuntimeAuthority,
  management?: CronManagementBinding,
  capture: "runtime" | "requester" = "runtime",
  isCurrent?: () => boolean,
): CronCreatorAuthorityGrant {
  if (
    !scope.active ||
    scope.signal.aborted ||
    operationSignal?.aborted ||
    scope.isCurrent?.() === false ||
    isCurrent?.() === false ||
    (scope.managementEntitlement?.source === "channel-owner" &&
      !scope.managementEntitlement.isCurrent())
  ) {
    throw management ? expiredManagementError() : expiredAuthorityError();
  }
  // Remote admission can prove the requester, never materialize fresh runtime authority.
  if (
    !management &&
    scope.managementEntitlement &&
    scope.callerOrigin.kind === "unknown" &&
    !(capture === "requester" && scope.callerScopedCreation)
  ) {
    throw new TypeError(
      "Automation creation is not granted to this turn. Use the Automations page to create an automation.",
    );
  }
  if (
    capture === "requester" &&
    (!hasCronAuthenticatedRequester(scope) || runtimeAuthority || management)
  ) {
    throw new TypeError("requester-only cron authority requires authenticated creator facts");
  }
  if (
    management &&
    (!scope.managementEntitlement ||
      !CRON_MANAGEMENT_METHODS.some((method) => method === management.method) ||
      management.authority.operationalRunInstance.runId !== scope.runId ||
      !validateAgentRunDelegatedAuthority(management.authority))
  ) {
    throw expiredManagementError();
  }
  const token = randomBytes(32).toString("base64url");
  const normalizedRuntimeAuthority = runtimeAuthority
    ? cloneCronRuntimeAuthority(runtimeAuthority)
    : undefined;
  if (runtimeAuthority && !normalizedRuntimeAuthority) {
    throw new TypeError("cron creator runtime authority is invalid");
  }
  const entry: CronCreatorAuthorityGrantEntry = {
    scope,
    capturesRuntimeAuthority: capture === "runtime",
    ...(isCurrent ? { isCurrent } : {}),
    operationSignal,
    ...(normalizedRuntimeAuthority ? { runtimeAuthority: normalizedRuntimeAuthority } : {}),
    ...(management ? { management: { ...management, expiresAtMs: Date.now() + 60_000 } } : {}),
  };
  if (operationSignal) {
    entry.onOperationAbort = () => revokeCronCreatorAuthorityGrant(token);
  }
  grantsByToken.set(token, entry);
  scope.grantTokens.add(token);
  if (operationSignal && entry.onOperationAbort) {
    operationSignal.addEventListener("abort", entry.onOperationAbort, { once: true });
  }
  return Object.freeze({ runId: scope.runId, token });
}

/** Reads private capture facts only for the same live, authenticated run. */
export function resolveCronCreatorAuthorityGrantProvenance(
  grant: CronCreatorAuthorityGrant,
  runId: string,
):
  | {
      capturesRuntimeAuthority: boolean;
      callerOrigin?: CronScheduledToolCallerOrigin;
      channelRequester?: CronAuthenticatedChannelRequester;
    }
  | undefined {
  const entry = grantsByToken.get(grant.token);
  const scope = entry?.scope;
  if (
    !entry ||
    !scope ||
    entry.management ||
    !scope.active ||
    scope.signal.aborted ||
    entry.operationSignal?.aborted ||
    entry.isCurrent?.() === false ||
    scope.isCurrent?.() === false ||
    (scope.managementEntitlement?.source === "channel-owner" &&
      !scope.managementEntitlement.isCurrent()) ||
    scope.runId !== grant.runId ||
    scope.runId !== runId
  ) {
    return undefined;
  }
  const channelRequester = channelRequestersByScope.get(scope);
  return {
    capturesRuntimeAuthority: entry.capturesRuntimeAuthority,
    ...(scope.callerOrigin.kind === "local" ? { callerOrigin: { kind: "local" as const } } : {}),
    ...(channelRequester ? { channelRequester: { ...channelRequester } } : {}),
  };
}

/** A requester grant proves identity without claiming a complete executable surface. */
export function hasCronCreatorGrantProvenance(
  input: {
    cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
    cronToolsAllowCapture?: "final-executable-surface";
  },
  runId: string,
): boolean {
  if (
    !input.cronCreatorAuthorityGrant ||
    input.cronToolsAllowCapture === "final-executable-surface"
  ) {
    return true;
  }
  const provenance = resolveCronCreatorAuthorityGrantProvenance(
    input.cronCreatorAuthorityGrant,
    runId,
  );
  return Boolean(provenance?.callerOrigin || provenance?.channelRequester);
}

function revokeCronCreatorAuthorityGrant(token: string): void {
  const entry = grantsByToken.get(token);
  if (!entry) {
    return;
  }
  grantsByToken.delete(token);
  entry.scope.grantTokens.delete(token);
  if (entry.operationSignal && entry.onOperationAbort) {
    entry.operationSignal.removeEventListener("abort", entry.onOperationAbort);
  }
}

export function revokeCronCreatorAuthorityRunScope(scope: CronCreatorAuthorityRunScope): void {
  if (!scope.active) {
    return;
  }
  scope.active = false;
  scope.abort();
  channelRequestersByScope.delete(scope);
  for (const token of scope.grantTokens) {
    revokeCronCreatorAuthorityGrant(token);
  }
}

/** Consumes one live exact-run grant synchronously at the cron commit boundary. */
export function consumeCronCreatorAuthorityGrant(
  grant: CronCreatorAuthorityGrant,
): CronRuntimeAuthority | undefined {
  const runId = grant.runId.trim();
  const token = grant.token.trim();
  const entry = token ? grantsByToken.get(token) : undefined;
  if (!entry) {
    throw expiredAuthorityError();
  }
  const scope = entry.scope;
  const issuerIsCurrent = entry.isCurrent?.() !== false;
  if (
    entry.management ||
    !scope.active ||
    scope.signal.aborted ||
    entry.operationSignal?.aborted ||
    !issuerIsCurrent ||
    scope.isCurrent?.() === false ||
    (scope.managementEntitlement?.source === "channel-owner" &&
      !scope.managementEntitlement.isCurrent()) ||
    scope.runId !== runId
  ) {
    if (
      !scope.active ||
      scope.signal.aborted ||
      entry.operationSignal?.aborted ||
      !issuerIsCurrent
    ) {
      revokeCronCreatorAuthorityGrant(token);
    }
    throw expiredAuthorityError();
  }
  revokeCronCreatorAuthorityGrant(token);
  return entry.runtimeAuthority ? cloneCronRuntimeAuthority(entry.runtimeAuthority) : undefined;
}

function expiredManagementError(): TypeError {
  return new TypeError(
    "Automation admin grant is missing, expired, or already used. Retry from a fresh authenticated configured channel owner or Control UI administrator turn, or use the Automations page.",
  );
}

/** Redeem once, retaining the exact operational owner through every await and commit. */
export async function withCronManagementGrant<T>(
  grant: CronCreatorAuthorityGrant,
  identity: CronManagementCaller,
  method: string,
  run: () => Promise<T>,
): Promise<T> {
  const entry = grantsByToken.get(grant.token);
  const management = entry?.management;
  const authority = identity.delegatedAuthority;
  if (
    !entry ||
    !management ||
    management.method !== method ||
    grant.runId !== entry.scope.runId ||
    management.authority.operationalRunInstance.instanceId !==
      identity.operationalRunInstance.instanceId ||
    management.authority.operationalRunInstance.runId !== identity.operationalRunInstance.runId ||
    management.authority.lifecycleGeneration !== authority.lifecycleGeneration ||
    management.authority.claimId !== authority.claimId
  ) {
    throw expiredManagementError();
  }
  revokeCronCreatorAuthorityGrant(grant.token);
  const assertActive = () => {
    if (
      !entry.scope.active ||
      entry.scope.signal.aborted ||
      entry.operationSignal?.aborted ||
      entry.scope.isCurrent?.() === false ||
      (entry.scope.managementEntitlement?.source === "channel-owner" &&
        !entry.scope.managementEntitlement.isCurrent()) ||
      Date.now() >= management.expiresAtMs ||
      !validateAgentRunDelegatedAuthority(management.authority)
    ) {
      throw expiredManagementError();
    }
  };
  assertActive();
  // Queue acknowledgement precedes reservation. Its retained guard still
  // belongs to this exact live run, signal, and expiry after the RPC returns.
  return await activeManagement.run(
    {
      identity,
      assertActive,
      ...(entry.scope.callerOrigin.kind === "local"
        ? { callerOrigin: { kind: "local" as const } }
        : {}),
      channelRequester: channelRequestersByScope.get(entry.scope),
    },
    run,
  );
}

export function getCronManagementAuthority(
  identity: CronManagementCaller,
): (() => void) | undefined {
  const management = activeManagement.getStore();
  return management?.identity === identity ? management.assertActive : undefined;
}

export function getCronManagementChannelRequester(
  identity: CronManagementCaller,
): CronAuthenticatedChannelRequester | undefined {
  const management = activeManagement.getStore();
  if (management?.identity !== identity) {
    return undefined;
  }
  management.assertActive();
  return management.channelRequester ? { ...management.channelRequester } : undefined;
}

export function getCronManagementCallerOrigin(
  identity: CronManagementCaller,
): CronScheduledToolCallerOrigin | undefined {
  const management = activeManagement.getStore();
  if (management?.identity !== identity) {
    return undefined;
  }
  management.assertActive();
  return management.callerOrigin ? { ...management.callerOrigin } : undefined;
}
