import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "../../agents/conversation-capability-profile.js";
import { resolveConversationToolPolicies } from "../../agents/conversation-tool-policy-pipeline.js";
import {
  bindReplyToolAuthorityCallerRead,
  isToolAuthorityReadCaptureActive,
  prepareReplyToolAuthorityCallerRead,
  recordPreparedToolAuthorityRead,
  type PreparedQuestionCallerRead,
} from "../../agents/harness/host-private-capabilities.js";
import { readOperatorModelPolicyMembership } from "../../agents/operator-model-policy.js";
import {
  resolveSandboxRuntimeStatus,
  withSandboxRuntimeStatusInWorker,
} from "../../agents/sandbox/runtime-status.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  prepareGatewaySessionEntryReadOnlyInWorker,
  type GatewaySessionEntryReadPlan,
} from "../../gateway/session-utils-store-worker.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { RuntimeMsgContext } from "../templating.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue/types.js";
import type {
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRoute,
  ReplyToolAuthoritySnapshot,
} from "./reply-run-registry.contracts.js";
import { prepareNativeReplyToolAuthorityRead } from "./reply-tool-authority.native-read.js";

export type ReplyToolAuthorityInput = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  originatingChannel?: FollowupRun["originatingChannel"];
  toolsAllow?: string[];
  disableTools?: boolean;
  run: Partial<
    Pick<
      FollowupRun["run"],
      | "config"
      | "sessionKey"
      | "runtimePolicySessionKey"
      | "agentId"
      | "agentDir"
      | "agentAccountId"
      | "messageProvider"
      | "chatType"
      | "conversationToolPolicy"
      | "groupId"
      | "groupChannel"
      | "groupSpace"
      | "memberRoleIds"
      | "spawnedBy"
      | "senderId"
      | "senderName"
      | "senderUsername"
      | "senderE164"
      | "senderIsOwner"
      | "cwd"
      | "inputProvenance"
      | "trustedInternalHandoff"
      | "scheduledToolPolicy"
      | "runtimePluginToolGrant"
      | "permissionMode"
      | "toolOverrides"
      | "execOverrides"
      | "elevatedLevel"
      | "bashElevated"
      | "traceAuthorized"
      | "approvalReviewerDeviceId"
      | "authProfileId"
      | "authProfileIdSource"
      | "clientCaps"
      | "gatewayUiCommandTarget"
      | "toolBindings"
    >
  > &
    Pick<FollowupRun["run"], "sessionId" | "sessionFile" | "workspaceDir" | "provider" | "model">;
};

/** Projects current inbound facts against the active run's frozen authority snapshot. */
export function resolveInboundReplyToolAuthorityOverlay(params: {
  ctx: RuntimeMsgContext;
  sessionEntry?: Pick<SessionEntry, "permissionMode" | "spawnedBy" | "toolOverrides">;
  senderIsOwner: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  toolsAllow?: string[];
  disableTools: boolean;
}): ReplyToolAuthorityOverlay {
  const { ctx } = params;
  return {
    operatorAuthority: params.operatorAuthority,
    permissionMode: params.sessionEntry?.permissionMode,
    toolOverrides: params.sessionEntry?.toolOverrides,
    originatingChannel: ctx.OriginatingChannel,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: ctx.OriginatingChannel,
      provider: ctx.Provider ?? ctx.Surface,
    }),
    chatType: normalizeChatType(ctx.ChatType),
    agentAccountId: ctx.AccountId,
    conversationToolPolicy: ctx.ConversationToolPolicy,
    groupId: resolveGroupSessionKey(ctx)?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    memberRoleIds: normalizeArrayBackedTrimmedStringList(ctx.MemberRoleIds),
    spawnedBy: normalizeOptionalString(params.sessionEntry?.spawnedBy),
    senderId: normalizeOptionalString(ctx.SenderId),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164: normalizeOptionalString(ctx.SenderE164),
    senderIsOwner: params.senderIsOwner,
    inputProvenance: ctx.InputProvenance,
    trustedInternalHandoff: undefined,
    scheduledToolPolicy: undefined,
    runtimePluginToolGrant: undefined,
    toolsAllow: params.toolsAllow,
    disableTools: params.disableTools,
    traceAuthorized:
      params.senderIsOwner || (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
    approvalReviewerDeviceId: normalizeOptionalString(ctx.ApprovalReviewerDeviceId),
    clientCaps: ctx.GatewayClientCaps,
    gatewayUiCommandTarget: ctx.GatewayUiCommandTarget,
    toolBindings: ctx.GatewayRunToolBindings,
  };
}

function applyReplyToolAuthorityOverlay(
  snapshot: ReplyToolAuthorityInput,
  overlay: ReplyToolAuthorityOverlay,
): ReplyToolAuthorityInput {
  return {
    ...snapshot,
    originatingChannel: overlay.originatingChannel,
    operatorAuthority: overlay.operatorAuthority,
    toolsAllow: overlay.toolsAllow,
    disableTools: overlay.disableTools,
    run: {
      ...snapshot.run,
      permissionMode: overlay.permissionMode,
      toolOverrides: overlay.toolOverrides,
      messageProvider: overlay.messageProvider,
      chatType: overlay.chatType,
      agentAccountId: overlay.agentAccountId,
      conversationToolPolicy: overlay.conversationToolPolicy,
      groupId: overlay.groupId,
      groupChannel: overlay.groupChannel,
      groupSpace: overlay.groupSpace,
      memberRoleIds: overlay.memberRoleIds,
      spawnedBy: overlay.spawnedBy,
      senderId: overlay.senderId,
      senderName: overlay.senderName,
      senderUsername: overlay.senderUsername,
      senderE164: overlay.senderE164,
      senderIsOwner: overlay.senderIsOwner,
      inputProvenance: overlay.inputProvenance,
      trustedInternalHandoff: overlay.trustedInternalHandoff,
      scheduledToolPolicy: overlay.scheduledToolPolicy,
      runtimePluginToolGrant: overlay.runtimePluginToolGrant,
      traceAuthorized: overlay.traceAuthorized,
      approvalReviewerDeviceId: overlay.approvalReviewerDeviceId,
      clientCaps: overlay.clientCaps,
      gatewayUiCommandTarget: overlay.gatewayUiCommandTarget,
      toolBindings: overlay.toolBindings,
    },
  };
}

export function resolveReplyToolAuthorityContext(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
  preparedSandbox?: ReturnType<typeof resolveSandboxRuntimeStatus>,
) {
  const execution = snapshot.run;
  const provider = route?.provider ?? execution.provider;
  const model = route?.model ?? execution.model;
  const policySessionKey = execution.runtimePolicySessionKey ?? execution.sessionKey;
  const sandboxRuntime =
    preparedSandbox ??
    resolveSandboxRuntimeStatus({
      cfg: execution.config,
      agentId: execution.agentId,
      sessionKey: execution.sessionKey,
      classificationSessionKey: policySessionKey,
    });
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: execution.config,
    sessionId: execution.sessionId,
    // Capability identity follows execution, not the independent sandbox policy owner.
    sessionKey: execution.sessionKey,
    sandboxSessionKey: policySessionKey,
    agentId: execution.agentId,
    agentAccountId: execution.agentAccountId,
    modelProvider: provider,
    modelId: model,
    messageProvider: execution.messageProvider,
    messageChannel: snapshot.originatingChannel,
    conversationToolPolicy: execution.conversationToolPolicy,
    groupId: execution.groupId,
    groupChannel: execution.groupChannel,
    groupSpace: execution.groupSpace,
    spawnedBy: execution.spawnedBy,
    senderId: execution.senderId,
    senderName: execution.senderName,
    senderUsername: execution.senderUsername,
    senderE164: execution.senderE164,
    senderIsOwner: execution.senderIsOwner,
    workspaceDir: execution.workspaceDir,
    cwd: execution.cwd,
    sandboxToolPolicy: sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined,
    inputProvenance: execution.inputProvenance,
    trustedInternalHandoff: execution.trustedInternalHandoff,
    scheduledToolPolicy: execution.scheduledToolPolicy,
    runtimePluginToolGrant: execution.runtimePluginToolGrant,
  });
  return { provider, model, capabilityProfile };
}

async function withPreparedReplyToolAuthorityContext<T>(
  input: ReplyToolAuthorityInput,
  route: ReplyToolAuthorityRoute | undefined,
  assertCurrent: () => void,
  consume: (context: ReturnType<typeof resolveReplyToolAuthorityContext>) => Promise<T>,
  source?: Omit<Parameters<typeof withSandboxRuntimeStatusInWorker>[1], "assertCurrent">,
): Promise<T> {
  const assertActive = () => {
    assertCurrent();
    assertCurrentOperatorAuthority(input.operatorAuthority);
  };
  return withSandboxRuntimeStatusInWorker(
    {
      cfg: input.run.config,
      agentId: input.run.agentId,
      sessionKey: input.run.sessionKey,
      classificationSessionKey: input.run.runtimePolicySessionKey ?? input.run.sessionKey,
    },
    { env: { ...process.env }, cwd: process.cwd(), ...source, assertCurrent: assertActive },
    async (sandbox) => {
      assertActive();
      const result = await consume(resolveReplyToolAuthorityContext(input, route, sandbox));
      assertActive();
      return result;
    },
  );
}

function isReplyToolAllowed(
  input: ReplyToolAuthorityInput,
  toolName: string,
  preparedProfile?: ResolvedConversationCapabilityProfile,
): boolean {
  if (input.disableTools === true || !isRuntimeToolAllowed(toolName, input.toolsAllow)) {
    return false;
  }
  const policies = resolveConversationToolPolicies({
    capabilityProfile: preparedProfile ?? resolveReplyToolAuthorityContext(input).capabilityProfile,
  });
  return isToolAllowedByPolicies(toolName, [
    ...Object.values(policies),
    input.run.senderIsOwner === false ? { deny: [...GATEWAY_OWNER_ONLY_CORE_TOOLS] } : undefined,
  ]);
}

/** Browser identity matters to admission only while this turn can control the UI. */
export function resolveReplyScreenToolTarget(
  input: ReplyToolAuthorityInput,
  preparedProfile?: ResolvedConversationCapabilityProfile,
) {
  return input.run.gatewayUiCommandTarget &&
    hasGatewayClientCap(input.run.clientCaps, GATEWAY_CLIENT_CAPS.UI_COMMANDS) &&
    isReplyToolAllowed(input, "screen", preparedProfile)
    ? input.run.gatewayUiCommandTarget
    : undefined;
}

/** Profile appearance remains requester-scoped even without browser control. */
export function resolveReplyThemeProfileId(
  input: ReplyToolAuthorityInput,
  preparedProfile?: ResolvedConversationCapabilityProfile,
): string | undefined {
  return input.run.gatewayUiCommandTarget?.profileId &&
    isReplyToolAllowed(input, "theme", preparedProfile)
    ? input.run.gatewayUiCommandTarget.profileId
    : undefined;
}

const operatorAuthorityIdentities = resolveGlobalSingleton(
  Symbol.for("openclaw.replyOperatorAuthorityIdentities"),
  () => ({ keys: new WeakMap<object, number>(), nextId: 1 }),
);

/** Compare original live owners without treating profile labels as authority. */
export function resolveReplyOperatorAuthorityKey(
  authority: AdmittedRunOperatorAuthority | undefined,
): string {
  if (!authority) {
    return "";
  }
  const identity = (value: object): number => {
    let key = operatorAuthorityIdentities.keys.get(value);
    if (key === undefined) {
      key = operatorAuthorityIdentities.nextId++;
      operatorAuthorityIdentities.keys.set(value, key);
    }
    return key;
  };
  return JSON.stringify([
    authority.profileId,
    [...new Set(authority.scopes.map((scope) => scope.trim()).filter(Boolean))].toSorted(),
    identity(authority.source ?? authority),
  ]);
}

function assertCurrentOperatorAuthority(authority: AdmittedRunOperatorAuthority | undefined): void {
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
  }
}

/** Fingerprints the complete model-facing tool authority owned by one queued turn. */
export function resolveFollowupRunToolAuthorityFingerprint(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
  preparedContext?: ReturnType<typeof resolveReplyToolAuthorityContext>,
): string {
  const execution = snapshot.run;
  const { provider, model, capabilityProfile } =
    preparedContext ?? resolveReplyToolAuthorityContext(snapshot, route);
  const authority = snapshot.operatorAuthority;
  assertCurrentOperatorAuthority(authority);
  const screenTarget = resolveReplyScreenToolTarget(snapshot, capabilityProfile);
  const themeProfileId = resolveReplyThemeProfileId(snapshot, capabilityProfile);
  return createHash("sha256")
    .update(
      stableStringify({
        provider,
        model,
        policy: capabilityProfile.policy,
        operatorAuthority: authority
          ? {
              scopes: [...new Set(authority.scopes)].toSorted(),
              rolePolicy: authority.rolePolicy,
              gatewayAccessGrant:
                authority.gatewayAccessGrant === undefined
                  ? resolveReplyOperatorAuthorityKey(authority)
                  : authority.gatewayAccessGrant,
              modelPolicy:
                readOperatorModelPolicyMembership(authority.modelPolicy) ??
                resolveReplyOperatorAuthorityKey(authority),
            }
          : undefined,
        toolsAllow: snapshot.toolsAllow,
        toolsAllowIntersection: snapshot.toolsAllow
          ? readToolAllowlistIntersection(snapshot.toolsAllow)
          : undefined,
        disableTools: snapshot.disableTools === true,
        sessionFile: execution.sessionFile,
        agentDir: execution.agentDir,
        workspaceDir: execution.workspaceDir,
        cwd: execution.cwd,
        permissionMode: execution.permissionMode,
        toolOverrides: execution.toolOverrides,
        execOverrides: execution.execOverrides,
        elevatedLevel: execution.elevatedLevel,
        bashElevated: execution.bashElevated,
        traceAuthorized: execution.traceAuthorized === true,
        // Automatic credential rotation retains the turn; explicit account pins stay exact.
        authProfile:
          execution.authProfileIdSource === "auto"
            ? { source: "auto" }
            : { id: execution.authProfileId },
        clientCaps: [...new Set(execution.clientCaps ?? [])].toSorted(),
        // Own-profile targets retain the running turn's original bindings.
        gatewayUiCommandTarget:
          authority && screenTarget?.profileId === authority.profileId
            ? { ownProfile: true }
            : screenTarget,
        themeProfileId:
          authority && themeProfileId === authority.profileId
            ? { ownProfile: true }
            : themeProfileId,
        toolBindings: execution.toolBindings,
      }),
    )
    .digest("hex");
}

export async function resolveFollowupRunToolAuthorityFingerprintAsync(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
  assertCurrent: () => void = () => {},
): Promise<string> {
  if (isToolAuthorityReadCaptureActive()) {
    const owner = prepareReplyToolAuthority(snapshot);
    const fingerprint = await owner.fingerprintAsync(route);
    await prepareReplyToolAuthorityCallerRead(
      owner.projectAsync,
      undefined,
      fingerprint,
      route,
      assertCurrent,
    );
    return fingerprint;
  }
  return withPreparedReplyToolAuthorityContext(snapshot, route, assertCurrent, async (context) =>
    resolveFollowupRunToolAuthorityFingerprint(snapshot, route, context),
  );
}

/** Capture execution policy once; incoming overlays replace only caller-owned facts. */
export function prepareReplyToolAuthority(
  run: ReplyToolAuthorityInput,
  narrow?: (input: ReplyToolAuthorityInput) => ReplyToolAuthorityInput,
): ReplyToolAuthoritySnapshot &
  Required<Pick<ReplyToolAuthoritySnapshot, "fingerprintAsync" | "projectAsync">> {
  const handoff = run.run.trustedInternalHandoff;
  const toolsAllow = run.toolsAllow ? [...run.toolsAllow] : undefined;
  const intersection = run.toolsAllow
    ? readToolAllowlistIntersection(run.toolsAllow)?.map((restriction) => restriction.slice())
    : undefined;
  if (toolsAllow && intersection) {
    attachToolAllowlistIntersection(toolsAllow, intersection);
  }
  const snapshot: ReplyToolAuthorityInput = {
    originatingChannel: run.originatingChannel,
    operatorAuthority: run.operatorAuthority,
    toolsAllow,
    disableTools: run.disableTools === true,
    run: {
      ...run.run,
      config: run.run.config ? captureRuntimeConfig(run.run.config) : undefined,
      conversationToolPolicy: structuredClone(run.run.conversationToolPolicy),
      inputProvenance: structuredClone(run.run.inputProvenance),
      scheduledToolPolicy: structuredClone(run.run.scheduledToolPolicy),
      runtimePluginToolGrant: structuredClone(run.run.runtimePluginToolGrant),
      // Copy policy facts while retaining the settle owner's live revocation check.
      trustedInternalHandoff: handoff
        ? {
            ...handoff,
            settleBatch: handoff.settleBatch && {
              ...handoff.settleBatch,
              sourceSessionKeys: [...handoff.settleBatch.sourceSessionKeys],
            },
          }
        : undefined,
      toolOverrides: structuredClone(run.run.toolOverrides),
      execOverrides: structuredClone(run.run.execOverrides),
      bashElevated: structuredClone(run.run.bashElevated),
      toolBindings: structuredClone(run.run.toolBindings),
      clientCaps: run.run.clientCaps ? [...run.run.clientCaps] : undefined,
      gatewayUiCommandTarget: structuredClone(run.run.gatewayUiCommandTarget),
      memberRoleIds: run.run.memberRoleIds ? [...run.run.memberRoleIds] : undefined,
    },
  };
  const projectInput = (overlay?: ReplyToolAuthorityOverlay) => {
    const incoming = overlay ? applyReplyToolAuthorityOverlay(snapshot, overlay) : snapshot;
    return narrow ? narrow(incoming) : incoming;
  };
  const env = { ...process.env };
  const cwd = process.cwd();
  let captured:
    | {
        storePath: string;
        canonicalKey: string;
        storeKeys: readonly string[];
        agentId: string;
        source: Awaited<
          ReturnType<typeof prepareGatewaySessionEntryReadOnlyInWorker>
        >["loaded"]["capturedReadSource"];
        sources: Awaited<
          ReturnType<typeof prepareGatewaySessionEntryReadOnlyInWorker>
        >["loaded"]["capturedReadSources"];
        sessionId: string | undefined;
        lifecycleRevision: SessionEntry["lifecycleRevision"];
      }
    | undefined;
  let capturedReadPlan: GatewaySessionEntryReadPlan | undefined;
  const assertClassificationSession = (
    entry: SessionEntry | undefined,
    expected: typeof captured,
  ) => {
    if (
      expected &&
      (entry?.sessionId !== expected.sessionId ||
        entry?.lifecycleRevision !== expected.lifecycleRevision)
    ) {
      throw new Error("Tool authority classification session changed");
    }
  };
  const prepare = async (input: ReplyToolAuthorityInput, route?: ReplyToolAuthorityRoute) => {
    const assertCurrent = () => {
      assertCurrentOperatorAuthority(snapshot.operatorAuthority);
      assertCurrentOperatorAuthority(input.operatorAuthority);
    };
    const key = snapshot.run.runtimePolicySessionKey ?? snapshot.run.sessionKey;
    capturedReadPlan?.assertCurrent();
    const preparedLookup = key
      ? await prepareGatewaySessionEntryReadOnlyInWorker({
          cfg: snapshot.run.config ?? {},
          key,
          agentId: resolveSessionAgentId({
            config: snapshot.run.config,
            sessionKey: key,
            fallbackAgentId: key === snapshot.run.sessionKey ? snapshot.run.agentId : undefined,
          }),
          env,
          assertActive: assertCurrent,
        })
      : undefined;
    if (preparedLookup) {
      const loaded = preparedLookup.loaded;
      const identity = {
        storePath: loaded.storePath,
        canonicalKey: loaded.canonicalKey,
        storeKeys: [...loaded.storeKeys],
        agentId: loaded.agentId,
        source: loaded.capturedReadSource,
        sources: loaded.capturedReadSources,
        sessionId: loaded.entry?.sessionId,
        lifecycleRevision: loaded.entry?.lifecycleRevision,
      };
      if (captured && !isDeepStrictEqual(identity, captured)) {
        throw new Error("Tool authority classification source changed");
      }
      if (!captured) {
        captured = identity;
        capturedReadPlan = preparedLookup.readPlan;
      }
      capturedReadPlan?.assertCurrent();
    }
    return withPreparedReplyToolAuthorityContext(
      input,
      route,
      assertCurrent,
      async (context) => resolveFollowupRunToolAuthorityFingerprint(input, route, context),
      {
        env,
        cwd,
        readSource: captured?.source,
        assertEntryCurrent: (entry) => assertClassificationSession(entry, captured),
      },
    );
  };
  const result = {
    personalToolOwner: {
      operatorAuthority: snapshot.operatorAuthority,
      senderId: snapshot.run.senderId,
      senderName: snapshot.run.senderName,
      gatewayUiCommandTarget: snapshot.run.gatewayUiCommandTarget,
    },
    requestedRoute: Object.freeze({ provider: snapshot.run.provider, model: snapshot.run.model }),
    fingerprint: (route?: ReplyToolAuthorityRoute) =>
      resolveFollowupRunToolAuthorityFingerprint(snapshot, route),
    fingerprintAsync: (route?: ReplyToolAuthorityRoute) => prepare(snapshot, route),
    projectAsync: async (overlay: ReplyToolAuthorityOverlay, route: ReplyToolAuthorityRoute) => {
      assertCurrentOperatorAuthority(snapshot.operatorAuthority);
      return prepare(projectInput(overlay), route);
    },
    project: (overlay: ReplyToolAuthorityOverlay, route: ReplyToolAuthorityRoute) => {
      // Steering retains the running turn's authority and browser bindings across reconnects.
      assertCurrentOperatorAuthority(snapshot.operatorAuthority);
      return resolveFollowupRunToolAuthorityFingerprint(projectInput(overlay), route);
    },
  };
  bindReplyToolAuthorityCallerRead(
    result.projectAsync,
    async (caller, expected, route, assertActive) => {
      if (isIncognitoSessionKey(snapshot.run.runtimePolicySessionKey ?? snapshot.run.sessionKey)) {
        if (!captured) {
          await prepare(snapshot, route);
        }
        const original = captured;
        if (!original) {
          throw new Error("Tool authority classification source is unavailable");
        }
        recordPreparedToolAuthorityRead(
          prepareNativeReplyToolAuthorityRead(original, assertActive),
        );
        // Published lineage is SQL-free; mutable native policy still uses compatibility.
        return undefined;
      }
      await prepare(snapshot, route);
      assertActive();
      const original = captured;
      const projected = projectInput(caller);
      const plan = capturedReadPlan;
      if (original && !plan) {
        throw new Error("Tool authority classification source is unavailable");
      }
      const assertSources = () => {
        assertActive();
        plan?.assertCurrent();
      };
      const assertEntry = (entry: SessionEntry | undefined) => {
        assertSources();
        assertClassificationSession(entry, original);
        const sandbox = resolveSandboxRuntimeStatus({
          cfg: snapshot.run.config,
          agentId: snapshot.run.agentId,
          sessionKey: snapshot.run.sessionKey,
          classificationSessionKey: snapshot.run.runtimePolicySessionKey ?? snapshot.run.sessionKey,
          preparedSessionEntry: entry ?? null,
        });
        for (const input of [snapshot, projected]) {
          if (
            resolveFollowupRunToolAuthorityFingerprint(
              input,
              route,
              resolveReplyToolAuthorityContext(input, route, sandbox),
            ) !== expected
          ) {
            throw new Error("question answer caller policy does not match its creator");
          }
        }
        assertSources();
      };
      const reads = plan?.reads ?? [];
      const assertPrepared: PreparedQuestionCallerRead["assertPrepared"] = (currentReads) => {
        assertSources();
        assertEntry(plan?.selectPrepared(currentReads));
      };
      const prepared: PreparedQuestionCallerRead = {
        reads,
        assertPrepared,
        prepareCurrent: () => withSessionEntriesFromStoresInWorker(reads, assertPrepared),
        retainNative() {
          assertSources();
          // Secret writes retain their pre-existing other-owner check at both worker grants.
          const retained = plan?.retainNative();
          if (!retained) {
            return { assertCurrent: () => assertEntry(undefined), release: () => {} };
          }
          const assertCurrent = () => {
            assertSources();
            assertEntry(retained.readCurrent());
          };
          // Consumers validate policy at the effect boundary; retention only pins the reader.
          return { assertCurrent, release: retained.release };
        },
      };
      recordPreparedToolAuthorityRead({
        ...prepared,
        assertLegacyCurrent: () => {
          assertSources();
          assertEntry(plan?.readLegacy());
        },
      });
      return prepared;
    },
  );
  return result;
}
