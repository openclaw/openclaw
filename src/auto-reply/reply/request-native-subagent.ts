import type {
  AdmittedRunOperatorAuthority,
  PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveStoredSessionPermissionPolicy } from "../../agents/tool-fs-policy.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type {
  NativeSubagentCommandFactory,
  NativeSubagentRuntimeGuard,
} from "../../plugins/runtime/native-subagent-context.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";

type CommandNativeRuntime = NonNullable<Awaited<ReturnType<NativeSubagentCommandFactory>>>;

type RequesterAuthorization = {
  isAuthorizedSender: boolean;
  senderIsOwner: boolean;
  assertOwnerCurrent?: () => void;
};

export type NativeSubagentRequesterState = {
  cfg: OpenClawConfig;
  sessionAgentId: string;
  sessionKey: string | undefined;
  entry: SessionEntry | undefined;
  runId?: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  authorizeRequester: () => Promise<RequesterAuthorization>;
  resolveToolAuthority: (authorization: RequesterAuthorization) => ReplyToolAuthorityOverlay;
  messageChannel?: string;
  messageTo?: string;
  getAbortSignal: () => AbortSignal | undefined;
  assertCurrent: () => void;
  /** Ingress owns turn adoption, recorder commitment and exact receipt validation. */
  commitTurn: (assertCurrent: () => void) => Promise<boolean>;
  /** Cron supplies genuine schedule admission; live ingress retains its existing channel producer. */
  prepareAdmission?: (params: {
    cfg: OpenClawConfig;
    runId: string;
    agentId: string;
    operatorAuthority: AdmittedRunOperatorAuthority;
    assertSourceCurrent: () => void;
    onAdmitted: NonNullable<Parameters<typeof prepareChannelRunAdmission>[0]["onAdmitted"]>;
  }) => PreparedAgentRunAdmission;
  /** Only the live external-command owner sets this; scheduled runs cannot recursively schedule. */
  enableScheduledTurns?: boolean;
  ingress?: Pick<
    Parameters<typeof prepareChannelRunAdmission>[0],
    "ingressKind" | "boundary" | "evidence" | "gatewayLocalUserIngress"
  >;
  /** Undefined retains the legacy lazy hook path. Commands reauthorize each run. */
  commandIngressEligible?: boolean;
};

/** One per-run gate for live and requester-admitted scheduled command ingress.
 * Host metadata/provenance and current authority are explicit inputs; prepare verifies
 * both native tools and commits the ingress-owned user turn. No fake message is needed.
 */
export async function resolveCommandNativeSubagentEligibility(params: {
  command: NativeSubagentRuntimeGuard["command"];
  ingressEligible: boolean;
  assertCurrent: () => void;
  authorizeRequester: () => Promise<RequesterAuthorization>;
  prepare: (owner: RequesterAuthorization) => Promise<CommandNativeRuntime | undefined>;
}): Promise<CommandNativeRuntime | undefined> {
  if (
    !params.ingressEligible ||
    params.command?.requireAuth !== true ||
    !params.command.runtimeCapabilities?.includes("subagents")
  ) {
    return undefined;
  }
  params.assertCurrent();
  const owner = await params.authorizeRequester();
  params.assertCurrent();
  owner.assertOwnerCurrent?.();
  if (!owner.isAuthorizedSender) {
    return undefined;
  }
  try {
    const runtime = await params.prepare(owner);
    params.assertCurrent();
    owner.assertOwnerCurrent?.();
    return runtime;
  } catch {
    // Revocation/cancellation still fail closed. Other preparation failures leave
    // this optional capability absent, never authorize an alternate spawn route.
    params.assertCurrent();
    owner.assertOwnerCurrent?.();
    return undefined;
  }
}

/** Ingress owners supply real authority, lineage and committed input, not plugin arguments. */
export async function withRequesterNativeSubagents<T>(
  state: NativeSubagentRequesterState,
  run: (create: NativeSubagentCommandFactory) => Promise<T>,
): Promise<T> {
  let admission: PreparedAgentRunAdmission | undefined;
  const invocation = new AbortController();
  try {
    const create: NativeSubagentCommandFactory = async (guard) => {
      const { cfg, sessionAgentId, sessionKey, entry, runId, operatorAuthority } = state;
      const signal = AbortSignal.any(
        [state.getAbortSignal(), guard.signal, invocation.signal].filter(
          (value): value is AbortSignal => value !== undefined,
        ),
      );
      if (!sessionKey || !entry?.sessionId || !runId || !operatorAuthority) {
        if (state.commandIngressEligible !== undefined) {
          return undefined;
        }
        throw new Error(
          "Native subagents require an admitted requester session, turn, and operator authority.",
        );
      }
      const assertCurrent = () => {
        guard.assertCurrent();
        signal.throwIfAborted();
        operatorAuthority.assertCurrent();
        state.assertCurrent();
      };
      const prepare = async (
        owner: RequesterAuthorization,
      ): Promise<CommandNativeRuntime | undefined> => {
        assertCurrent();
        const workspaceDir =
          entry.spawnedWorkspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
        const overlay = state.resolveToolAuthority(owner);
        const model = resolveSessionModelRef(cfg, entry, sessionAgentId);
        const options = {
          ...overlay,
          config: cfg,
          agentId: sessionAgentId,
          sessionKey,
          sessionId: entry.sessionId,
          runId,
          workspaceDir,
          cwd: entry.spawnedCwd ?? workspaceDir,
          sessionPermissionPolicy: resolveStoredSessionPermissionPolicy(entry, workspaceDir),
          runtimeToolAllowlist: overlay.disableTools ? [] : overlay.toolsAllow,
          inheritRuntimeToolAllowlist: true,
          modelProvider: model.provider,
          modelId: model.model,
          requesterModel: model,
          abortSignal: signal,
          allowGatewaySubagentBinding: true,
          messageChannel: state.messageChannel,
          messageTo: state.messageTo,
        };
        const { prepareConversationCapabilityProfile } =
          await import("../../agents/conversation-capability-profile.js");
        const { createRequestNativeSubagentRuntime } =
          await import("../../agents/plugin-native-subagent.js");
        assertCurrent();
        // Rebuild current policy with the same owner-prepared session and sandbox inputs.
        const prepareCurrentCapabilityProfile = async (config: OpenClawConfig) => {
          assertCurrent();
          owner.assertOwnerCurrent?.();
          const sandbox = resolvePreparedSandboxRuntimeStatus({
            cfg: config,
            agentId: sessionAgentId,
            sessionKey,
            preparedSessionEntry: entry,
          });
          const profile = await prepareConversationCapabilityProfile({
            ...options,
            config,
            sandboxToolPolicy: sandbox.sandboxed ? sandbox.toolPolicy : undefined,
            preparedSessionEntry: { sessionKey, entry },
          });
          assertCurrent();
          owner.assertOwnerCurrent?.();
          return profile;
        };
        const conversationCapabilityProfile = await prepareCurrentCapabilityProfile(cfg);
        assertCurrent();
        const runtime = createRequestNativeSubagentRuntime(
          {
            options: { ...options, conversationCapabilityProfile },
            prepareCurrentCapabilityProfile,
            lifecycleRevision: entry.lifecycleRevision,
            operatorAuthority,
            assertCurrent: () => {
              assertCurrent();
              owner.assertOwnerCurrent?.();
            },
            async prepareSpawn(assertSpawnCurrent) {
              if (!(await state.commitTurn(assertSpawnCurrent))) {
                throw new Error("Native subagent spawn requires committed user-turn input.");
              }
              assertSpawnCurrent();
              if (!admission) {
                const scope = getPluginRuntimeGatewayRequestScope();
                const resolveGatewayContext =
                  scope?.resolveGatewayContext ?? scope?.context?.resolveGatewayContext;
                if (!resolveGatewayContext) {
                  throw new Error("Native subagent controller requires its Gateway binding.");
                }
                if (!state.prepareAdmission && !state.ingress) {
                  throw new Error("Native command requires its ingress admission producer.");
                }
                admission = (
                  state.prepareAdmission ??
                  ((input) => prepareChannelRunAdmission({ ...input, ...state.ingress! }))
                )({
                  cfg,
                  runId,
                  agentId: sessionAgentId,
                  operatorAuthority,
                  // Accepted children retain the operator source, not this invocation.
                  assertSourceCurrent: () => {
                    operatorAuthority.assertCurrent();
                    owner.assertOwnerCurrent?.();
                  },
                  onAdmitted: (context) =>
                    bindGatewayContextResolver(context, resolveGatewayContext),
                });
              }
              return await admission.admit("plugin-harness", guard.pluginId);
            },
          },
          guard,
        );
        if (state.commandIngressEligible !== undefined && !(await runtime.prepareCommand())) {
          return undefined;
        }
        const scheduledTurns =
          state.enableScheduledTurns &&
          guard.command?.runtimeCapabilities?.includes("scheduledTurns")
            ? await runtime.prepareScheduledTurns(state.messageChannel ?? "")
            : undefined;
        assertCurrent();
        return {
          ...(scheduledTurns ? { scheduledTurns } : {}),
          spawn: (params) => runtime.spawn(params),
          collect: (params) => runtime.collect(params),
          ...(runtime.list ? { list: runtime.list } : {}),
        };
      };
      if (state.commandIngressEligible !== undefined) {
        return await resolveCommandNativeSubagentEligibility({
          command: guard.command,
          ingressEligible: state.commandIngressEligible,
          assertCurrent,
          authorizeRequester: state.authorizeRequester,
          prepare,
        });
      }
      assertCurrent();
      const owner = await state.authorizeRequester();
      assertCurrent();
      return await prepare(owner);
    };
    return await run(create);
  } finally {
    invocation.abort("native subagent invocation closed");
    admission?.close();
  }
}
