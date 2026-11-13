import { rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  withOpenClawStateLeaseAsync,
  type OpenClawStateAsyncLeaseContext,
} from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { selectNextTemplateAgentId } from "./add-agent-id.js";
import { isRetainedTemplateInitialization } from "./add-checkpoint.js";
import {
  applyTemplateAddPlanStateless,
  type StatelessTemplateAddOptions,
} from "./add-stateless.js";
import { TemplateAddMutationError } from "./add.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { TemplateSetupFailure, TemplateSetupReport } from "./conversation.js";
import type { PersistedTemplateCronRef } from "./cron.js";
import type { GatewayTemplateAddApplyResult } from "./gateway-add-apply.js";
import {
  templateInitializationCheckpoints,
  type AdmittedTemplateAgent,
} from "./gateway-add-continuation.js";
import {
  buildGatewayTemplateAddPlan,
  type GatewayTemplateAddPlanningContext,
} from "./gateway-add-plan.js";
import { installTemplateMcpServersStateless } from "./mcp.js";
import { installTemplatePackages } from "./packages.js";
import { templateManifestWorkspaceConflictsWithPath } from "./schema.js";
import type { TemplateAddPlan, TemplateAddPlanAction, TemplateReadResult } from "./types.js";

type VerifiedTemplateSource = Extract<TemplateReadResult, { ok: true }>;
type TemplateAgentConfig = TemplateAddPlan["agent"]["config"];

const MANIFEST_FILE = "CLAW.md";
/** The agent's own conversation finishes setup with these tools. */
const SETUP_TOOLS = ["automations", "plugins", "message"];

/**
 * Add what the Template's own allowlist omits. A Template without an allowlist
 * inherits the operator's policy, which this agent entry does not narrow. A tool
 * the Template explicitly denies stays denied: creation adds grants, it does not
 * lift an author's restriction.
 */
function allowSetupTools(tools: TemplateAgentConfig["tools"]): TemplateAgentConfig["tools"] {
  const allow = tools?.allow;
  return allow
    ? {
        ...tools,
        allow: [
          ...allow,
          ...SETUP_TOOLS.filter((tool) => !isToolAllowedByPolicyName(tool, { allow })),
        ],
      }
    : tools;
}

function withoutAgent(config: OpenClawConfig, agentId: string): OpenClawConfig {
  const entries = { ...config.agents?.entries };
  delete entries[agentId];
  return { ...config, agents: { ...config.agents, entries } };
}

function dependencyFailure(
  plan: TemplateAddPlan,
  source: VerifiedTemplateSource,
  action: TemplateAddPlanAction,
  reason: string,
): TemplateSetupFailure {
  if (action.kind === "mcpServer") {
    return { kind: "mcpServer", name: action.id, reason };
  }
  const details = action.details ?? {};
  const collection = details.kind === "skill" ? "skills" : "plugins";
  const index = source.manifest[collection].findIndex((entry) =>
    "path" in entry ? entry.path === details.path : entry.ref === details.ref,
  );
  const declared = source.manifest[collection][index];
  return {
    kind: details.kind === "skill" ? "skill" : "plugin",
    name:
      declared && "ref" in declared
        ? declared.ref
        : typeof details.name === "string"
          ? details.name
          : (declared?.path ?? action.id),
    // A blocked bundled action carries no reason; its blocker is filed under the declaration.
    reason:
      plan.blockers.find((blocker) => blocker.path === `$.${collection}[${index}]`)?.message ??
      reason,
  };
}

/** The installer settled with the agent kept; its own result already says why. */
class KeptTemplateAgentError extends Error {
  constructor(readonly failure: { code: string; message: string }) {
    super(failure.message);
    this.name = "KeptTemplateAgentError";
  }
}

export type ChatTemplateAddInput = ClawHubFetchOptions & {
  source: ClawHubCoordinate;
  acknowledgeClawHubRisk?: boolean;
  getPlanningContext: () => Promise<GatewayTemplateAddPlanningContext>;
  assertCurrent: () => void;
  signal?: AbortSignal;
  stateDir?: string;
  reloadPlugins?: PluginInstallBatchReload;
  configWriteOptions?: StatelessTemplateAddOptions["configWriteOptions"];
  waitForAgentRuntime?: StatelessTemplateAddOptions["waitForAgentRuntime"];
  rollbackNewAgent?: (
    agentId: string,
    expectedAgentConfig: TemplateAgentConfig,
    expectedCronJobs: PersistedTemplateCronRef[],
  ) => Promise<void>;
  /** Creation has finished; the agent's first turn starts here with its outcome. */
  onAgentCreated?: (
    agent: { agentId: string; sessionKey: string },
    report: TemplateSetupReport,
  ) => Promise<void>;
};

/**
 * The id chat-based Add admits. A taken preferred id yields the next unused one,
 * unless it is this release's own unfinished Add, which the request resumes. Two
 * concurrent Adds of one Template may pick the same id; creation refuses the second.
 */
export async function selectChatTemplateAgentId(
  admissionContext: Promise<
    { ok: true; value: GatewayTemplateAddPlanningContext } | { ok: false; error: unknown }
  >,
  input: Pick<ChatTemplateAddInput, "source" | "assertCurrent"> & { agentId?: string },
): Promise<string> {
  const context = await admissionContext;
  if (!context.ok) {
    throw context.error;
  }
  const { config } = context.value;
  const preferredId = normalizeAgentId(input.agentId);
  return config.agents?.entries?.[preferredId] &&
    (await isRetainedTemplateInitialization(config, preferredId, input.source, input.assertCurrent))
    ? preferredId
    : selectNextTemplateAgentId(preferredId, listAgentIds(config));
}

/**
 * Chat-based Add: turn an admitted agent into the Template's agent in code, then
 * hand what is left to that agent's first turn. There is no reviewed plan, so
 * nothing here asks: clean skills and bundled plugins install, and anything that
 * would need a decision is reported instead. Plugins the Template references on
 * ClawHub and its automations are left to the conversation.
 *
 * Throws only when no agent or chat remains. Every kept state is a result.
 */
export async function createTemplateAgentFromChat(
  input: ChatTemplateAddInput,
  admitted: AdmittedTemplateAgent | undefined,
  sessionKey: string | undefined,
  stateContext: OpenClawStateWorkerContext,
): Promise<GatewayTemplateAddApplyResult> {
  if (!admitted || !sessionKey) {
    throw new Error("Chat-based Template Add requires an agent id and a chat owner.");
  }
  const agentId = admitted.agentId;
  const report: TemplateSetupReport = { failures: [], mcpServers: [] };
  let initialized = false;
  const kept = (error?: { code: string; message: string }): GatewayTemplateAddApplyResult => ({
    agentId,
    status: error ? "partial" : "complete",
    ...(error ? { agentRetained: true as const } : {}),
    ...(initialized ? {} : { initializationPending: true as const }),
    sessionKey,
    readiness: { ready: !error && report.failures.length === 0, requirements: [] },
    ...(error ? { error } : {}),
  });
  const agentLease = { scope: "core:agent-deletion", key: agentId, leaseMs: 60_000, waitMs: 5_000 };

  const configure = async (
    source: VerifiedTemplateSource,
    lease: OpenClawStateAsyncLeaseContext,
  ): Promise<StatelessTemplateAddOptions> => {
    const assertCurrent = () => {
      input.assertCurrent();
      lease.assertCurrent();
    };
    // Only the agent and its files decide whether creation proceeds, and only they
    // are bound into the retry checkpoint. Dependencies are planned once it exists.
    const planned = await buildGatewayTemplateAddPlan(
      {
        ...source,
        manifest: { ...source.manifest, skills: [], plugins: [], mcpServers: {}, automations: [] },
      },
      {
        config: withoutAgent((await input.getPlanningContext()).config, agentId),
        sourceMcpServers: {},
        agentId,
        admittedWorkspace: admitted.workspace,
      },
    );
    assertCurrent();
    if (planned.blockers.length > 0) {
      throw new TemplateAddMutationError("plan_blocked", planned.blockers[0]!.message);
    }
    const manifestClaimed = templateManifestWorkspaceConflictsWithPath(
      source.manifest,
      MANIFEST_FILE,
    );
    const plan: TemplateAddPlan = {
      ...planned,
      agent: {
        ...planned.agent,
        config: { ...planned.agent.config, tools: allowSetupTools(planned.agent.config.tools) },
      },
      actions: [
        // The planner turns a legacy heartbeat declaration and its HEARTBEAT.md into an
        // automation. Creation makes none, so that retired file is not written either.
        ...planned.actions.filter((action) => action.kind !== "cronJob"),
        ...(manifestClaimed
          ? []
          : [
              {
                kind: "workspaceFile" as const,
                id: MANIFEST_FILE,
                action: "write" as const,
                target: resolve(planned.agent.workspace, MANIFEST_FILE),
                source: planned.template.manifestPath,
                sourceKind: "templateManifest" as const,
                digest: source.snapshot.manifest.digest,
                details: { expectedState: "absent" },
                blocked: false,
              },
            ]),
      ],
    };
    const options: StatelessTemplateAddOptions = {
      stateMode: "worker",
      assertCurrent,
      prepareEffect: async () => {
        await lease.assertOwned();
        assertCurrent();
        if (!initialized) {
          await admitted.chat.assertCurrent?.();
        }
      },
      leaseSet: { context: stateContext, leases: [lease] },
      admittedAgent: {
        config: admitted.config,
        workspaceIdentity: admitted.workspaceIdentity,
        preparing: admitted.preparing,
        ...(admitted.configured ? { phase: "configured" as const, ...admitted.configured } : {}),
        assertCurrent: async () => {
          input.assertCurrent();
          await admitted.chat.assertCurrent?.();
        },
        ...(admitted.createdByRequest ? { discardOnFailure: true as const } : {}),
      },
      ...templateInitializationCheckpoints(admitted, input.source),
      ...(input.waitForAgentRuntime ? { waitForAgentRuntime: input.waitForAgentRuntime } : {}),
      // The chat becomes ordinary here; its first turn still waits for the report.
      onAgentReady: async () => {
        await admitted.chat.complete?.();
        initialized = true;
      },
      ...(input.configWriteOptions ? { configWriteOptions: input.configWriteOptions } : {}),
      // No digest was reviewed in this path; the installer only requires its own plan's.
      consentPlanIntegrity: plan.planIntegrity,
    };
    const core = await applyTemplateAddPlanStateless(plan, options);
    if (core.status !== "complete") {
      throw new KeptTemplateAgentError(
        core.error ?? { code: "add_failed", message: "Template Add did not finish." },
      );
    }
    if (manifestClaimed) {
      report.failures.push({
        kind: "manifest",
        name: MANIFEST_FILE,
        reason: `The Template's own workspace files claim ${MANIFEST_FILE}; that file was kept and the Template manifest was not copied.`,
      });
    }
    return options;
  };

  const installDependencies = async (
    source: VerifiedTemplateSource,
    options: StatelessTemplateAddOptions,
  ): Promise<void> => {
    const config = withoutAgent((await input.getPlanningContext()).config, agentId);
    const dependencies = await buildGatewayTemplateAddPlan(
      {
        ...source,
        manifest: {
          ...source.manifest,
          // A ClawHub plugin is never inspected, downloaded, installed or enabled here.
          plugins: source.manifest.plugins.filter((plugin) => "path" in plugin),
          automations: [],
        },
      },
      { config, sourceMcpServers: {}, agentId, admittedWorkspace: admitted.workspace },
    );
    const installOptions = {
      stateMode: options.stateMode,
      assertCurrent: options.assertCurrent,
      assertForwardCurrent: options.assertCurrent,
      prepareEffect: options.prepareEffect,
      leaseSet: options.leaseSet,
      config,
      ...(input.reloadPlugins ? { reloadPlugins: input.reloadPlugins } : {}),
      // No review step exists: a bundled plugin installs with the capabilities it
      // declares. One that carries a warning is reported below, never confirmed.
      pluginConsent: {
        onCapabilityConsent: async (review: { reviewToken: string }) => ({
          reviewToken: review.reviewToken,
        }),
      },
    };
    for (const action of dependencies.actions) {
      if (action.kind !== "package" && action.kind !== "mcpServer") {
        continue;
      }
      const fail = (reason: string) =>
        report.failures.push(dependencyFailure(dependencies, source, action, reason));
      const warning = action.details?.riskWarning;
      if (typeof warning === "string") {
        fail(`Not installed without your review. ${warning}`);
        continue;
      }
      if (action.blocked) {
        fail(action.reason ?? "This dependency cannot be installed.");
        continue;
      }
      try {
        const single = { ...dependencies, actions: [action] };
        if (action.kind === "package") {
          await installTemplatePackages(single, installOptions);
        } else {
          await installTemplateMcpServersStateless(single, { ...installOptions, refs: [] });
          report.mcpServers.push(action.id);
        }
      } catch (error) {
        // Lost authority ends creation; any other failure is one item to report.
        options.assertCurrent?.();
        fail(coerceErrorMessage(error));
      }
    }
  };

  let configured = false;
  let finished = false;
  try {
    await withResolvedClawHubSource({
      coordinate: input.source,
      mode: "apply",
      ...(input.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.token ? { token: input.token } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.stateDir ? { stateDir: input.stateDir } : {}),
      run: async (_extracted, _trust, persistSource) =>
        await withOpenClawStateLeaseAsync(
          {
            ...agentLease,
            heartbeat: "worker",
            signal: input.signal,
            leaseLabel: "Template add",
            operationLabel: "template.add.lease",
          },
          stateContext,
          async (lease) => {
            input.assertCurrent();
            const source = await persistSource();
            const options = await configure(source, lease);
            configured = true;
            await installDependencies(source, options);
            finished = true;
          },
        ),
    });
  } catch (error) {
    if (error instanceof KeptTemplateAgentError) {
      return kept(error.failure);
    }
    if (finished) {
      defaultRuntime.log("Template source cleanup failed after Add; cached files may remain.");
    } else if (configured || !admitted.createdByRequest) {
      return kept({
        code: error instanceof TemplateAddMutationError ? error.code : "template_setup_failed",
        message: configured
          ? coerceErrorMessage(error)
          : `${coerceErrorMessage(error)} The ordinary agent and conversation were kept; do not add another copy.`,
      });
    } else {
      // Nothing of the Template was kept: remove this request's own agent, then its
      // pending chat and empty workspace. A directory that is no longer empty is not ours.
      try {
        await withOpenClawStateLeaseAsync(
          {
            ...agentLease,
            heartbeat: "worker",
            signal: input.signal,
            leaseLabel: "Template add rollback",
            operationLabel: "template.add.rollback",
          },
          stateContext,
          async () => {
            if (!input.rollbackNewAgent) {
              throw new Error("Gateway agent rollback is unavailable.", { cause: error });
            }
            await input.rollbackNewAgent(
              agentId,
              {
                ...admitted.config,
                id: agentId,
                workspace: admitted.config.workspace ?? admitted.workspace,
              },
              [],
            );
          },
        );
      } catch (cleanupError) {
        return kept({
          code: "add_rollback_incomplete",
          message: `${coerceErrorMessage(error)} The agent could not be removed: ${coerceErrorMessage(cleanupError)}`,
        });
      }
      await admitted.chat();
      await rmdir(admitted.workspace).catch(() => {});
      throw error;
    }
  }
  try {
    await input.onAgentCreated?.({ agentId, sessionKey }, report);
  } catch (error) {
    return kept({ code: "template_opening_failed", message: coerceErrorMessage(error) });
  }
  return kept();
}
