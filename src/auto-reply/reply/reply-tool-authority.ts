import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
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
  recordPreparedToolAuthorityRead,
  type PreparedQuestionCallerRead,
} from "../../agents/harness/host-private-capabilities.js";
import { readOperatorModelPolicyMembership } from "../../agents/operator-model-policy.js";
import {
  captureRequesterOrigin,
  resolveRequesterPrincipalKey,
} from "../../agents/requester-origin.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import {
  prepareSessionCapabilityRead,
  type SessionCapabilityStore,
} from "../../agents/subagents/spawn/subagent-session-store.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import {
  prepareGatewaySessionEntryReadOnlyInWorker,
  type GatewaySessionEntryReadPlan,
} from "../../gateway/session-utils-store-worker.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { MessageInjectionRequesterMismatchError } from "./message-injection-authority.js";
import type {
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRequester,
  ReplyToolAuthorityRoute,
  ReplyToolAuthoritySnapshot,
} from "./reply-run-registry.contracts.js";
import {
  captureReplyToolAuthoritySession,
  retainReplyToolAuthorityClassification,
  withReplyToolAuthorityCohort,
  type CapturedReplyToolAuthoritySession,
} from "./reply-tool-authority-cohort.js";
import {
  applyReplyToolAuthorityOverlay,
  isSameReplyToolAuthorityConversation,
  type ReplyToolAuthorityInput,
} from "./reply-tool-authority-inbound.js";
import {
  captureMemoryReplyToolAuthoritySession,
  prepareMemoryReplyToolAuthorityCaller,
} from "./reply-tool-authority-memory.js";

export { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority-inbound.js";

function resolveReplyToolSandboxParams(execution: ReplyToolAuthorityInput["run"]) {
  return {
    cfg: execution.config,
    agentId: execution.agentId,
    sessionKey: execution.sessionKey,
    classificationSessionKey: execution.runtimePolicySessionKey ?? execution.sessionKey,
  };
}

export function resolveReplyToolAuthorityContext(
  snapshot: ReplyToolAuthorityInput,
  route: ReplyToolAuthorityRoute | undefined,
  preparedSandbox: ReturnType<typeof resolveSandboxRuntimeStatus>,
  preparedSessionCapabilityStore?: SessionCapabilityStore,
) {
  const execution = snapshot.run;
  const provider = route?.provider ?? execution.provider;
  const model = route?.model ?? execution.model;
  const policySessionKey = execution.runtimePolicySessionKey ?? execution.sessionKey;
  const sandboxRuntime = preparedSandbox;
  const capabilityProfile = resolveConversationCapabilityProfile({
    requesterOrigin: execution.requesterOrigin,
    config: execution.config,
    sessionId: execution.sessionId,
    // Capability identity follows execution, not the independent sandbox policy owner.
    sessionKey: execution.sessionKey,
    preparedSessionCapabilityStore,
    sandboxSessionKey: policySessionKey,
    agentId: execution.agentId,
    agentAccountId: execution.agentAccountId,
    modelProvider: provider,
    modelId: model,
    messageProvider: execution.messageProvider,
    messageChannel: snapshot.originatingChannel,
    chatType: execution.chatType,
    conversationToolPolicy: execution.conversationToolPolicy,
    conversationId: execution.conversationId,
    messageThreadId: execution.messageThreadId,
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

/** Screen needs browser control; theme remains requester-scoped without it. */
export function resolveReplyPersonalToolTargets(
  input: ReplyToolAuthorityInput,
  preparedProfile: ResolvedConversationCapabilityProfile,
) {
  const target = input.run.gatewayUiCommandTarget;
  let policies: ReturnType<typeof resolveConversationToolPolicies> | undefined;
  const isAllowed = (toolName: string) => {
    if (input.disableTools === true || !isRuntimeToolAllowed(toolName, input.toolsAllow)) {
      return false;
    }
    policies ??= resolveConversationToolPolicies({ capabilityProfile: preparedProfile });
    return isToolAllowedByPolicies(toolName, [
      ...Object.values(policies),
      input.run.senderIsOwner === false ? { deny: [...GATEWAY_OWNER_ONLY_CORE_TOOLS] } : undefined,
    ]);
  };
  return {
    screenTarget:
      target &&
      hasGatewayClientCap(input.run.clientCaps, GATEWAY_CLIENT_CAPS.UI_COMMANDS) &&
      isAllowed("screen")
        ? target
        : undefined,
    themeProfileId: target?.profileId && isAllowed("theme") ? target.profileId : undefined,
  };
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
  const source = authority.source ?? authority;
  let identity = operatorAuthorityIdentities.keys.get(source);
  if (identity === undefined) {
    identity = operatorAuthorityIdentities.nextId++;
    operatorAuthorityIdentities.keys.set(source, identity);
  }
  return JSON.stringify([
    authority.profileId,
    [...new Set(authority.scopes.map((scope) => scope.trim()).filter(Boolean))].toSorted(),
    identity,
  ]);
}

function assertCurrentOperatorAuthority(authority: AdmittedRunOperatorAuthority | undefined): void {
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
  }
}

/** Fingerprints the complete model-facing tool authority owned by one queued turn. */
function resolveFollowupRunToolAuthorityFingerprint(
  snapshot: ReplyToolAuthorityInput,
  preparedContext: ReturnType<typeof resolveReplyToolAuthorityContext>,
): string {
  const execution = snapshot.run;
  const { provider, model, capabilityProfile } = preparedContext;
  const authority = snapshot.operatorAuthority;
  assertCurrentOperatorAuthority(authority);
  const { screenTarget, themeProfileId } = resolveReplyPersonalToolTargets(
    snapshot,
    capabilityProfile,
  );
  return createHash("sha256")
    .update(
      stableStringify({
        requesterPrincipalKey: resolveRequesterPrincipalKey({
          ...execution,
          messageChannel: snapshot.originatingChannel,
          operatorAuthority: authority,
        }),
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

export async function prepareFollowupRunToolAuthorityFingerprint(
  snapshot: ReplyToolAuthorityInput,
  route?: ReplyToolAuthorityRoute,
  assertCurrent: () => void = () => {},
) {
  const owner = prepareReplyToolAuthority(snapshot);
  try {
    await owner.fingerprintAsync(route);
    assertCurrent();
    return {
      read: () => {
        assertCurrent();
        return owner.fingerprint(route);
      },
      release: owner.close,
    };
  } catch (error) {
    owner.close();
    throw error;
  }
}

export type ReplyToolAuthorityNarrow = (
  input: ReplyToolAuthorityInput,
  sandbox: ReturnType<typeof resolveSandboxRuntimeStatus>,
) => ReplyToolAuthorityInput;

/** Capture execution policy once; incoming overlays replace only caller-owned facts. */
function resolvePreparedReplyToolAuthorityFingerprint(
  input: ReplyToolAuthorityInput,
  route: ReplyToolAuthorityRoute | undefined,
  entry: SessionEntry | undefined,
  narrow?: ReplyToolAuthorityNarrow,
  preparedSessionCapabilityStore?: SessionCapabilityStore,
) {
  const sandbox = resolveSandboxRuntimeStatus({
    ...resolveReplyToolSandboxParams(input.run),
    preparedSessionEntry: entry ?? null,
  });
  const preparedInput = narrow?.(input, sandbox) ?? input;
  return resolveFollowupRunToolAuthorityFingerprint(
    preparedInput,
    resolveReplyToolAuthorityContext(preparedInput, route, sandbox, preparedSessionCapabilityStore),
  );
}

export function prepareReplyToolAuthority(
  run: ReplyToolAuthorityInput,
  narrow?: ReplyToolAuthorityNarrow,
  resolveReader?: () => SessionEntryCohortReader | undefined,
): ReplyToolAuthoritySnapshot &
  Required<
    Pick<
      ReplyToolAuthoritySnapshot,
      "fingerprintAsync" | "projectAsync" | "projectRequester" | "projectRequesterAsync" | "close"
    >
  > {
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
      requesterOrigin: run.run.requesterOrigin
        ? captureRequesterOrigin({ requesterOrigin: run.run.requesterOrigin })
        : undefined,
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
  const requesterPrincipalKey = resolveRequesterPrincipalKey({
    ...snapshot.run,
    messageChannel: snapshot.originatingChannel,
    operatorAuthority: snapshot.operatorAuthority,
  });
  const projectInput = (caller?: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester) => {
    if (
      caller &&
      !("requesterOrigin" in caller) &&
      caller.allowCollaborativeSteering &&
      requesterPrincipalKey &&
      resolveRequesterPrincipalKey({ ...caller, messageChannel: caller.originatingChannel }) &&
      (!caller.inputProvenance || caller.inputProvenance.kind === "external_user") &&
      isSameReplyToolAuthorityConversation(snapshot, caller)
    ) {
      assertCurrentOperatorAuthority(caller.operatorAuthority);
      // Only the policy projection uses the incumbent. The input and its author
      // remain unchanged, including if injection later falls back to a new turn.
      return snapshot;
    }
    const incoming = !caller
      ? snapshot
      : "requesterOrigin" in caller
        ? {
            ...snapshot,
            run: {
              ...snapshot.run,
              config: captureRuntimeConfig(caller.config),
              requesterOrigin: captureRequesterOrigin(caller),
              // This is a fresh request, not the incumbent's external snapshot or completion.
              conversationToolPolicy: undefined,
              trustedInternalHandoff: undefined,
              inputProvenance: undefined,
              scheduledToolPolicy: undefined,
            },
          }
        : applyReplyToolAuthorityOverlay(snapshot, caller);
    // Unidentified executions may run, but cannot lend their identity to new human input.
    if (
      caller &&
      (!requesterPrincipalKey ||
        requesterPrincipalKey !==
          resolveRequesterPrincipalKey({
            ...incoming.run,
            messageChannel: incoming.originatingChannel,
            operatorAuthority: incoming.operatorAuthority,
          }))
    ) {
      throw new MessageInjectionRequesterMismatchError();
    }
    return incoming;
  };
  const env = { ...process.env };
  const sessionKey = snapshot.run.runtimePolicySessionKey ?? snapshot.run.sessionKey;
  const memory = captureMemoryReplyToolAuthoritySession(sessionKey, () =>
    assertCurrentOperatorAuthority(snapshot.operatorAuthority),
  );
  const readMemoryEntry = memory?.readEntry;
  const memoryCapabilities = memory?.capabilities;
  let captured: CapturedReplyToolAuthoritySession | undefined;
  let capturedReadPlan: GatewaySessionEntryReadPlan | undefined;
  const releases = new Set<() => void>();
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Reply tool authority is closed");
    }
    assertCurrentOperatorAuthority(snapshot.operatorAuthority);
  };
  const close = () => {
    closed = true;
    for (const release of releases) {
      release();
    }
    releases.clear();
  };
  const retainEntry = (entry: SessionEntry | undefined) => {
    const predicate = memory
      ? undefined
      : retainReplyToolAuthorityClassification(captured, entry, assertOpen);
    if (!predicate) {
      return { assertCurrent() {}, release() {} };
    }
    const release = () => {
      predicate.release();
      releases.delete(release);
    };
    releases.add(release);
    return { assertCurrent: predicate.assertCurrent, release };
  };
  const prepareEntry = async (
    input: ReplyToolAuthorityInput,
    route: ReplyToolAuthorityRoute | undefined,
    entry: SessionEntry | undefined,
  ) => {
    assertOpen();
    if (
      captured &&
      (entry?.sessionId !== captured.sessionId ||
        entry?.lifecycleRevision !== captured.lifecycleRevision)
    ) {
      throw new Error("Tool authority classification source changed");
    }
    const assertEntry = retainEntry(entry);
    let selectedInput = input;
    let selectedRoute = route;
    const resolveFingerprint = () =>
      resolvePreparedReplyToolAuthorityFingerprint(
        selectedInput,
        selectedRoute,
        readMemoryEntry ? readMemoryEntry() : entry,
        narrow,
        memoryCapabilities,
      );
    const prepared = await prepareSessionCapabilityRead(() => {
      assertOpen();
      capturedReadPlan?.assertCurrent();
      assertEntry.assertCurrent();
      return resolveFingerprint();
    }).catch((error: unknown) => {
      assertEntry.release();
      throw error;
    });
    releases.add(prepared.release);
    return {
      read: prepared.read,
      evaluate(nextInput: ReplyToolAuthorityInput, nextRoute: ReplyToolAuthorityRoute | undefined) {
        selectedInput = nextInput;
        selectedRoute = nextRoute;
        return prepared.read();
      },
    };
  };
  const prepareFresh = async (input: ReplyToolAuthorityInput, route?: ReplyToolAuthorityRoute) => {
    assertOpen();
    assertCurrentOperatorAuthority(input.operatorAuthority);
    let entry: SessionEntry | undefined;
    if (readMemoryEntry) {
      entry = readMemoryEntry();
    } else if (capturedReadPlan) {
      entry = await withSessionEntriesFromStoresInWorker(capturedReadPlan.reads, (reads) =>
        capturedReadPlan!.selectPrepared(reads),
      );
    } else if (sessionKey) {
      const preparedLookup = await prepareGatewaySessionEntryReadOnlyInWorker({
        cfg: snapshot.run.config ?? {},
        key: sessionKey,
        agentId: resolveSessionAgentId({
          config: snapshot.run.config,
          sessionKey,
          fallbackAgentId:
            sessionKey === snapshot.run.sessionKey ? snapshot.run.agentId : undefined,
        }),
        env,
        assertActive: assertOpen,
      });
      entry = preparedLookup.loaded.entry;
      captured ??= captureReplyToolAuthoritySession(preparedLookup.loaded);
      capturedReadPlan ??= preparedLookup.readPlan;
    }
    return prepareEntry(input, route, entry);
  };
  const prepare = (input: ReplyToolAuthorityInput, route?: ReplyToolAuthorityRoute) =>
    memory
      ? prepareFresh(input, route)
      : withReplyToolAuthorityCohort({
          reader: resolveReader?.(),
          original: captured,
          readPlan: capturedReadPlan,
          env,
          assertCurrent: assertOpen,
          prepare: () => prepareFresh(input, route),
          consume: (entry) => prepareEntry(input, route, entry),
        });
  type PreparedFingerprint = Awaited<ReturnType<typeof prepare>>;
  let fingerprintRead: PreparedFingerprint | undefined;
  let projectionRead: PreparedFingerprint | undefined;
  const projectAsync = async (
    caller: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester,
    route: ReplyToolAuthorityRoute,
  ) => {
    const prepared = await prepare(projectInput(caller), route);
    if (!("requesterOrigin" in caller)) {
      assertCurrentOperatorAuthority(caller.operatorAuthority);
    }
    projectionRead = prepared;
    return prepared.read();
  };
  const project = (
    caller: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester,
    route: ReplyToolAuthorityRoute,
  ) => {
    const prepared = projectionRead ?? fingerprintRead;
    if (!prepared) {
      throw new Error("Reply tool authority requires asynchronous preparation");
    }
    return prepared.evaluate(projectInput(caller), route);
  };
  const result = {
    close,
    requesterPrincipalKey,
    personalToolOwner: {
      operatorAuthority: snapshot.operatorAuthority,
      senderId: snapshot.run.senderId,
      senderName: snapshot.run.senderName,
      gatewayUiCommandTarget: snapshot.run.gatewayUiCommandTarget,
    },
    requestedRoute: Object.freeze({ provider: snapshot.run.provider, model: snapshot.run.model }),
    fingerprint: (route?: ReplyToolAuthorityRoute) => {
      warnPluginSdkDeprecation({
        family: "reply-tool-authority-sync-preparation",
        method: "ReplyToolAuthoritySnapshot.fingerprint",
        replacement: "await fingerprintAsync()",
      });
      if (!fingerprintRead) {
        throw new Error("Reply tool authority requires asynchronous preparation");
      }
      return fingerprintRead.evaluate(snapshot, route);
    },
    fingerprintAsync: async (route?: ReplyToolAuthorityRoute) => {
      const prepared = await prepare(snapshot, route);
      fingerprintRead = prepared;
      return prepared.read();
    },
    projectAsync,
    project(overlay: ReplyToolAuthorityOverlay, route: ReplyToolAuthorityRoute) {
      warnPluginSdkDeprecation({
        family: "reply-tool-authority-sync-preparation",
        method: "ReplyToolAuthoritySnapshot.project",
        replacement: "await projectAsync()",
      });
      return project(overlay, route);
    },
    projectRequesterAsync: projectAsync,
    projectRequester: project,
  };
  bindReplyToolAuthorityCallerRead(
    result.projectAsync,
    async (caller, expected, route, assertActive) => {
      const projected = projectInput(caller);
      const policyInputs = projected === snapshot ? [snapshot] : [snapshot, projected];
      const assertCallerCurrent = () => {
        if (caller && !("requesterOrigin" in caller)) {
          assertCurrentOperatorAuthority(caller.operatorAuthority);
        }
      };
      if (readMemoryEntry) {
        const policy = await prepareSessionCapabilityRead(() => {
          assertCallerCurrent();
          return policyInputs.every(
            (input) =>
              resolvePreparedReplyToolAuthorityFingerprint(
                input,
                route,
                readMemoryEntry(),
                undefined,
                memoryCapabilities,
              ) === expected,
          );
        });
        releases.add(policy.release);
        const prepared = prepareMemoryReplyToolAuthorityCaller(readMemoryEntry, assertActive, () =>
          policy.read(),
        );
        recordPreparedToolAuthorityRead({
          ...prepared,
          assertLegacyCurrent: () => prepared.assertPrepared([]),
        });
        return prepared;
      }
      // The consuming phase rereads this plan's original sources before checking policy.
      if (!captured) {
        await prepare(snapshot, route);
      }
      assertActive();
      const original = captured;
      const plan = capturedReadPlan;
      if (original && !plan) {
        throw new Error("Tool authority classification source is unavailable");
      }
      const assertSources = () => {
        assertActive();
        assertCallerCurrent();
        plan?.assertCurrent();
      };
      const assertEntry = (entry: SessionEntry | undefined) => {
        assertSources();
        if (
          original &&
          (entry?.sessionId !== original.sessionId ||
            entry?.lifecycleRevision !== original.lifecycleRevision)
        ) {
          throw new Error(
            "Tool authority classification session changed (caller session identity)",
          );
        }
        for (const input of policyInputs) {
          if (
            resolvePreparedReplyToolAuthorityFingerprint(input, route, entry, narrow) !== expected
          ) {
            throw new Error("question answer caller policy does not match its creator");
          }
        }
        assertSources();
      };
      const reads = plan?.reads ?? [];
      let currentEntry: SessionEntry | undefined;
      let receipt: ReturnType<typeof retainEntry> | undefined;
      const installCurrent = (
        currentReads: Parameters<PreparedQuestionCallerRead["assertPrepared"]>[0],
      ) => {
        assertSources();
        currentEntry = plan?.selectPrepared(currentReads);
        receipt?.release();
        receipt = retainEntry(currentEntry);
      };
      await withSessionEntriesFromStoresInWorker(reads, installCurrent);
      const policy = await prepareSessionCapabilityRead(() => {
        receipt?.assertCurrent();
        assertEntry(currentEntry);
      });
      releases.add(policy.release);
      const assertPrepared: PreparedQuestionCallerRead["assertPrepared"] = (currentReads) => {
        installCurrent(currentReads);
        policy.read();
      };
      const prepared: PreparedQuestionCallerRead = {
        reads,
        assertPrepared,
        prepareCurrent: () => withSessionEntriesFromStoresInWorker(reads, assertPrepared),
        retainCurrent() {
          policy.read();
          return { assertCurrent: policy.read, release() {} };
        },
      };
      recordPreparedToolAuthorityRead({
        ...prepared,
        assertLegacyCurrent: policy.read,
      });
      return prepared;
    },
  );
  return result;
}
