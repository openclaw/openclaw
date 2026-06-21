// Generic allow-always persistence for plugin approval requests.
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";
import type { PluginApprovalRequestPayload, PluginApprovalResolved } from "./plugin-approvals.js";
import { resolvePluginApprovalRequestAllowedDecisions } from "./plugin-approvals.js";

const PLUGIN_APPROVAL_ALLOW_ALWAYS_OWNER_ID = "core:plugin-approvals";
const PLUGIN_APPROVAL_ALLOW_ALWAYS_NAMESPACE = "allow-always";
const MAX_PLUGIN_APPROVAL_ALLOW_ALWAYS_ENTRIES = 10_000;

type PluginApprovalAllowAlwaysScope = {
  pluginId: string;
  toolName: string;
  allowAlwaysKey: string;
};

type PluginApprovalAllowAlwaysEntry = {
  version: 1;
  pluginId: string;
  toolName: string;
  approvedAtMs: number;
};

export type PluginApprovalAllowAlwaysReuse = {
  id: string;
  decision: Extract<ExecApprovalDecision, "allow-always">;
  createdAtMs: number;
  expiresAtMs: number;
};

const allowAlwaysStore = createCorePluginStateSyncKeyedStore<PluginApprovalAllowAlwaysEntry>({
  ownerId: PLUGIN_APPROVAL_ALLOW_ALWAYS_OWNER_ID,
  namespace: PLUGIN_APPROVAL_ALLOW_ALWAYS_NAMESPACE,
  maxEntries: MAX_PLUGIN_APPROVAL_ALLOW_ALWAYS_ENTRIES,
});

function resolvePluginApprovalAllowAlwaysScope(
  request: PluginApprovalRequestPayload,
): PluginApprovalAllowAlwaysScope | null {
  const pluginId = normalizeOptionalString(request.pluginId);
  const toolName = normalizeOptionalString(request.toolName);
  const allowAlwaysKey = normalizeOptionalString(request.allowAlwaysKey);
  if (!pluginId || !toolName || !allowAlwaysKey) {
    return null;
  }
  return { pluginId, toolName, allowAlwaysKey };
}

function requestOffersAllowAlways(request: PluginApprovalRequestPayload): boolean {
  return resolvePluginApprovalRequestAllowedDecisions(request).includes("allow-always");
}

function fingerprintPluginApprovalAllowAlwaysScope(scope: PluginApprovalAllowAlwaysScope): string {
  const hash = createHash("sha256");
  hash.update("openclaw:plugin-approval:allow-always:v1");
  hash.update("\0");
  hash.update(JSON.stringify(scope));
  return hash.digest("hex");
}

function resolvePluginApprovalAllowAlwaysFingerprint(
  request: PluginApprovalRequestPayload,
): { fingerprint: string; scope: PluginApprovalAllowAlwaysScope } | null {
  if (!requestOffersAllowAlways(request)) {
    return null;
  }
  const scope = resolvePluginApprovalAllowAlwaysScope(request);
  if (!scope) {
    return null;
  }
  return {
    fingerprint: fingerprintPluginApprovalAllowAlwaysScope(scope),
    scope,
  };
}

function buildPluginApprovalAllowAlwaysReuseId(fingerprint: string): string {
  return `plugin:allow-always:${fingerprint.slice(0, 24)}`;
}

/** Return an immediate allow-always decision when a matching durable approval exists. */
export function resolvePluginApprovalAllowAlwaysReuse(
  request: PluginApprovalRequestPayload,
  nowMs = Date.now(),
): PluginApprovalAllowAlwaysReuse | null {
  const resolved = resolvePluginApprovalAllowAlwaysFingerprint(request);
  if (!resolved) {
    return null;
  }
  const entry = allowAlwaysStore.lookup(resolved.fingerprint);
  if (!entry || entry.version !== 1) {
    return null;
  }
  return {
    id: buildPluginApprovalAllowAlwaysReuseId(resolved.fingerprint),
    decision: "allow-always",
    createdAtMs: nowMs,
    expiresAtMs: nowMs,
  };
}

/** Persist allow-always for future requests with the same plugin/tool/key scope. */
export function rememberPluginApprovalAllowAlways(request: PluginApprovalRequestPayload): void {
  const resolved = resolvePluginApprovalAllowAlwaysFingerprint(request);
  if (!resolved) {
    return;
  }
  allowAlwaysStore.register(resolved.fingerprint, {
    version: 1,
    pluginId: resolved.scope.pluginId,
    toolName: resolved.scope.toolName,
    approvedAtMs: Date.now(),
  });
}

/** Persist a resolved plugin approval only when it actually chose allow-always. */
export function rememberPluginApprovalResolvedAllowAlways(
  resolved: Pick<PluginApprovalResolved, "decision" | "request">,
): void {
  if (resolved.decision !== "allow-always" || !resolved.request) {
    return;
  }
  rememberPluginApprovalAllowAlways(resolved.request);
}
