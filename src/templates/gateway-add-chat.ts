import { rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { withResolvedClawHubSource } from "./clawhub-source.js";
import type { TemplateSetupReport } from "./conversation.js";
import {
  templateInitializationCheckpoints,
  type AdmittedTemplateAgent,
} from "./gateway-add-continuation.js";
import type { ChatTemplateAddInput } from "./gateway-add-input.js";
import {
  buildGatewayTemplateAddPlan,
  type GatewayTemplateAddPlanningContext,
} from "./gateway-add-plan.js";
import type { GatewayTemplateAddApplyResult } from "./gateway-add-result.js";
import { templateManifestWorkspaceConflictsWithPath } from "./schema.js";
import { continueTemplateSetup } from "./setup-continuation.js";
import { measureTemplateAddStage } from "./timings.js";
import type { TemplateAddPlan, TemplateReadResult } from "./types.js";

type VerifiedTemplateSource = Extract<TemplateReadResult, { ok: true }>;
type TemplateAgentConfig = TemplateAddPlan["agent"]["config"];

const MANIFEST_FILE = "CLAW.md";
/** The agent reads its manifest and finishes setup in its own conversation. */
const SETUP_TOOLS = ["read", "automations", "plugins", "message"];

/**
 * The planner freezes declared profiles into full + allow. Extend that bounded
 * policy, or extend the inherited profile additively when no allowlist exists.
 * Global allow/deny and the Template's explicit denies still intersect these grants.
 */
function allowSetupTools(
  tools: TemplateAgentConfig["tools"],
  inheritedTools: OpenClawConfig["tools"],
): TemplateAgentConfig["tools"] {
  const allow = tools?.allow;
  if (allow) {
    return {
      ...tools,
      allow: [
        ...allow,
        ...SETUP_TOOLS.filter((tool) => !isToolAllowedByPolicyName(tool, { allow })),
      ],
    };
  }
  return {
    ...tools,
    alsoAllow: [
      ...new Set([...(tools?.alsoAllow ?? inheritedTools?.alsoAllow ?? []), ...SETUP_TOOLS]),
    ],
  };
}

function withoutAgent(config: OpenClawConfig, agentId: string): OpenClawConfig {
  const entries = { ...config.agents?.entries };
  delete entries[agentId];
  return { ...config, agents: { ...config.agents, entries } };
}

/** The installer settled with the agent kept; its own result already says why. */
class KeptTemplateAgentError extends Error {
  constructor(readonly failure: { code: string; message: string }) {
    super(failure.message);
    this.name = "KeptTemplateAgentError";
  }
}

/**
 * The id chat-based Add admits. A taken preferred id yields the next unused one,
 * unless it is this release's own unfinished Add, which the request resumes. Two
 * concurrent Adds of one Template may pick the same id; creation refuses the second.
 */
export async function selectChatTemplateAgentId(
  admissionContext: Promise<
    { ok: true; value: GatewayTemplateAddPlanningContext } | { ok: false; error: unknown }
  >,
  input: Pick<ChatTemplateAddInput, "source" | "assertCurrent" | "resume"> & { agentId?: string },
): Promise<string> {
  const context = await admissionContext;
  if (!context.ok) {
    throw context.error;
  }
  const { config } = context.value;
  const preferredId = normalizeAgentId(input.agentId);
  const retained =
    config.agents?.entries?.[preferredId] &&
    (await isRetainedTemplateInitialization(
      config,
      preferredId,
      input.source,
      input.assertCurrent,
    ));
  if (input.resume && !retained) {
    throw new Error("The Template creation checkpoint changed; Retry cannot create another agent.");
  }
  return retained ? preferredId : selectNextTemplateAgentId(preferredId, listAgentIds(config));
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
  const kept = (failure?: { code: string; message: string }): GatewayTemplateAddApplyResult => {
    const error =
      failure ??
      (report.failures.length
        ? {
            code: "template_setup_incomplete",
            message:
              "Some Template dependencies could not be set up. The agent and conversation were kept. Continue in this chat; do not add another copy.",
          }
        : undefined);
    return {
      agentId,
      status: error ? "partial" : "complete",
      ...(error ? { agentRetained: true as const } : {}),
      ...(initialized ? {} : { initializationPending: true as const }),
      sessionKey,
      readiness: { ready: !error, requirements: [] },
      ...(error ? { error } : {}),
    };
  };
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
    const config = (await input.getPlanningContext()).config;
    const planned = await buildGatewayTemplateAddPlan(
      {
        ...source,
        manifest: { ...source.manifest, skills: [], plugins: [], mcpServers: {}, automations: [] },
      },
      {
        config: withoutAgent(config, agentId),
        sourceMcpServers: {},
        agentId,
        admittedWorkspace: admitted.workspace,
      },
    );
    assertCurrent();
    if (planned.blockers.length > 0) {
      throw new TemplateAddMutationError("plan_blocked", planned.blockers[0]!.message);
    }
    if (templateManifestWorkspaceConflictsWithPath(source.manifest, MANIFEST_FILE)) {
      throw new TemplateAddMutationError(
        "workspace_conflict",
        `${MANIFEST_FILE} is reserved for the unchanged Template manifest in chat-based Add.`,
      );
    }
    const plan: TemplateAddPlan = {
      ...planned,
      agent: {
        ...planned.agent,
        config: {
          ...planned.agent.config,
          tools: allowSetupTools(planned.agent.config.tools, config.tools),
        },
      },
      actions: [
        // The planner turns a legacy heartbeat declaration and its HEARTBEAT.md into an
        // automation. Creation makes none, so that retired file is not written either.
        ...planned.actions.filter((action) => action.kind !== "cronJob"),
        {
          kind: "workspaceFile",
          id: MANIFEST_FILE,
          action: "write",
          target: resolve(planned.agent.workspace, MANIFEST_FILE),
          source: planned.template.manifestPath,
          sourceKind: "templateManifest",
          digest: source.snapshot.manifest.digest,
          details: { expectedState: "absent" },
          blocked: false,
        },
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
      // Finalize only workspace preparation; dependency setup continues alongside the opening.
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
    return options;
  };

  let preparedSource: VerifiedTemplateSource | undefined;
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
            const source = await measureTemplateAddStage(
              "source.persist-receipt",
              async () => await persistSource(),
            );
            await measureTemplateAddStage(
              "workspace-config.prepare",
              async () => await configure(source, lease),
            );
            preparedSource = source;
            configured = true;
            await measureTemplateAddStage(
              "session.finalize",
              async () =>
                await admitted.chat.complete?.({
                  source: input.source,
                  report,
                  dependenciesPending: true,
                }),
            );
            initialized = true;
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
  return (
    (await continueTemplateSetup(input, agentId, stateContext, preparedSource)) ??
    kept({
      code: "template_opening_failed",
      message: "Template setup continuation was not saved; the agent and conversation were kept.",
    })
  );
}
