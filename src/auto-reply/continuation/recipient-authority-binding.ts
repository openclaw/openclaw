import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  assertSessionRecipientAuthorityOwner,
  captureSessionRecipientAuthority,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  ContinuationRecipientAuthorityBindingSchema,
  type ContinuationRecipientAuthorityBinding,
  type SessionRecipientAuthority,
} from "../../config/sessions/session-recipient-authority-types.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting-pure.js";

export type ContinuationRecipientAuthorityBindingParseResult =
  | { state: "legacy" }
  | { state: "valid"; binding: ContinuationRecipientAuthorityBinding }
  | { state: "invalid" };

export function parseContinuationRecipientAuthorityBinding(
  value: unknown,
): ContinuationRecipientAuthorityBindingParseResult {
  if (value === undefined) {
    return { state: "legacy" };
  }
  const parsed = ContinuationRecipientAuthorityBindingSchema.safeParse(value);
  return parsed.success ? { state: "valid", binding: parsed.data } : { state: "invalid" };
}

export async function captureContinuationRecipientAuthorities(
  sessionKeys: readonly string[],
  fallbackAgentId?: string,
): Promise<ContinuationRecipientAuthorityBinding> {
  const needsFallback = sessionKeys.some((sessionKey) => !sessionKey.startsWith("agent:"));
  const defaultAgentId =
    fallbackAgentId ?? (needsFallback ? resolveDefaultAgentId(getRuntimeConfig()) : undefined);
  const recipients: Array<{ sessionKey: string; authority: SessionRecipientAuthority }> = [];
  // Every recipient is bound before the binding exists; a failed capture leaves none.
  for (const sessionKey of normalizeContinuationTargetKeys(sessionKeys)) {
    recipients.push({
      sessionKey,
      authority: await captureSessionRecipientAuthority({
        agentId: resolveAgentIdFromSessionKey(sessionKey, defaultAgentId),
        sessionKey,
      }),
    });
  }
  return { version: 1, selection: "selected", recipients };
}

export async function createContinuationRecipientAuthorityBinding(params: {
  requesterSessionKey: string;
  targetSessionKey?: string;
  targetSessionKeys?: readonly string[];
  fanoutMode?: "tree" | "all";
  requesterAgentId?: string;
}): Promise<ContinuationRecipientAuthorityBinding> {
  if (params.fanoutMode) {
    // A fanout binds its recipients at spawn and return, but the requester elects now: an
    // incognito requester is refused here, before any record exists, as a default return is.
    assertSessionRecipientAuthorityOwner({ sessionKey: params.requesterSessionKey });
    return { version: 1, selection: "pending", fanoutMode: params.fanoutMode };
  }
  const explicitTargets = normalizeContinuationTargetKeys([
    ...(params.targetSessionKey ? [params.targetSessionKey] : []),
    ...(params.targetSessionKeys ?? []),
  ]);
  return await captureContinuationRecipientAuthorities(
    explicitTargets.length > 0 ? explicitTargets : [params.requesterSessionKey],
    params.requesterAgentId,
  );
}

export async function resolveSpawnRecipientAuthorityBinding(params: {
  binding?: ContinuationRecipientAuthorityBinding;
  requesterSessionKey: string;
  targetSessionKey?: string;
  targetSessionKeys?: readonly string[];
  fanoutMode?: "tree" | "all";
  treeSessionKeys?: readonly string[];
}): Promise<ContinuationRecipientAuthorityBinding | undefined> {
  const parsed = parseContinuationRecipientAuthorityBinding(params.binding);
  if (parsed.state === "invalid") {
    throw new Error("Invalid continuation recipient authority binding before spawn");
  }
  if (parsed.state === "valid") {
    if (parsed.binding.selection === "pending" && parsed.binding.fanoutMode === "tree") {
      return await captureContinuationRecipientAuthorities(params.treeSessionKeys ?? []);
    }
    return parsed.binding;
  }
  if (params.fanoutMode === "all") {
    return { version: 1, selection: "pending", fanoutMode: "all" };
  }
  if (params.fanoutMode === "tree") {
    return await captureContinuationRecipientAuthorities(params.treeSessionKeys ?? []);
  }
  const targetSessionKey = normalizeContinuationTargetKey(params.targetSessionKey);
  const targetSessionKeys = normalizeContinuationTargetKeys(params.targetSessionKeys);
  if (!targetSessionKey && targetSessionKeys.length === 0) {
    return undefined;
  }
  return await captureContinuationRecipientAuthorities([
    ...(targetSessionKey ? [targetSessionKey] : []),
    ...targetSessionKeys,
  ]);
}

export function continuationRecipientAuthorityMap(
  binding: ContinuationRecipientAuthorityBinding,
  targetSessionKeys: readonly string[],
): ReadonlyMap<string, SessionRecipientAuthority> {
  if (binding.selection !== "selected") {
    throw new Error("Continuation recipient authority selection is still pending");
  }
  const authorities = new Map(
    binding.recipients.map((recipient) => [recipient.sessionKey, recipient.authority]),
  );
  for (const sessionKey of targetSessionKeys) {
    if (!authorities.has(sessionKey)) {
      throw new Error(`Continuation recipient authority binding is missing target ${sessionKey}`);
    }
  }
  return authorities;
}

function resolveScopedContinuationRecipientAgentId(sessionKey: string): string | undefined {
  return sessionKey.startsWith("agent:") ? resolveAgentIdFromSessionKey(sessionKey) : undefined;
}

function resolveUnscopedContinuationRecipientAgentId(params: {
  sessionKey: string;
  targets: ReturnType<typeof resolveAllAgentSessionStoreTargetsSync>;
  env: NodeJS.ProcessEnv;
}): string {
  let ownerAgentId: string | undefined;

  for (const target of params.targets) {
    const entry = loadSessionEntry({
      agentId: target.agentId,
      env: params.env,
      sessionKey: params.sessionKey,
      storePath: target.storePath,
    });
    if (!entry) {
      continue;
    }
    if (ownerAgentId && ownerAgentId !== target.agentId) {
      throw new Error(`Continuation recipient owner is ambiguous for target ${params.sessionKey}`);
    }
    ownerAgentId = target.agentId;
  }

  if (!ownerAgentId) {
    throw new Error(`Continuation recipient owner is unavailable for target ${params.sessionKey}`);
  }
  return ownerAgentId;
}

export function resolveContinuationRecipientAgentIds(
  cfg: OpenClawConfig,
  sessionKeys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, string> {
  let targets: ReturnType<typeof resolveAllAgentSessionStoreTargetsSync> | undefined;
  return new Map(
    normalizeContinuationTargetKeys(sessionKeys).map((sessionKey) => {
      const scopedAgentId = resolveScopedContinuationRecipientAgentId(sessionKey);
      if (scopedAgentId) {
        return [sessionKey, scopedAgentId] as const;
      }
      // Explicit agent keys stay allocation-free; only legacy/global aliases need
      // durable store discovery to prove one recipient owner.
      targets ??= resolveAllAgentSessionStoreTargetsSync(cfg, { env });
      return [
        sessionKey,
        resolveUnscopedContinuationRecipientAgentId({
          sessionKey,
          targets,
          env,
        }),
      ] as const;
    }),
  );
}
