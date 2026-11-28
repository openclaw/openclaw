import { coerceErrorMessage } from "@openclaw/normalization-core";
import type { OpenClawStateAsyncLeaseContext } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { TemplateSetupFailure, TemplateSetupReport } from "./conversation.js";
import type { ChatTemplateAddInput } from "./gateway-add-input.js";
import { buildGatewayTemplateAddPlan } from "./gateway-add-plan.js";
import { installTemplateMcpServersStateless } from "./mcp.js";
import { installTemplatePackages } from "./packages.js";
import { measureTemplateAddStage } from "./timings.js";
import type { TemplateAddPlan, TemplateAddPlanAction, TemplateReadResult } from "./types.js";

type VerifiedTemplateSource = Extract<TemplateReadResult, { ok: true }>;
function withoutAgent(
  config: import("../config/types.openclaw.js").OpenClawConfig,
  agentId: string,
) {
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

/** Workspace preparation is complete. Install only declared dependencies under its existing lease. */
export async function finishTemplateDependencies(
  source: VerifiedTemplateSource,
  input: ChatTemplateAddInput,
  agentId: string,
  workspace: string,
  stateContext: OpenClawStateWorkerContext,
  lease: OpenClawStateAsyncLeaseContext,
): Promise<TemplateSetupReport> {
  const report: TemplateSetupReport = { failures: [], mcpServers: [] };
  const options = {
    stateMode: "worker" as const,
    assertCurrent: () => {
      input.assertCurrent();
      lease.assertCurrent();
    },
    prepareEffect: async () => {
      await lease.assertOwned();
      input.assertCurrent();
      lease.assertCurrent();
    },
    leaseSet: { context: stateContext, leases: [lease] },
  };
  const config = withoutAgent((await input.getPlanningContext()).config, agentId);
  const dependencySource = {
    ...source,
    manifest: {
      ...source.manifest,
      // A ClawHub plugin is never inspected, downloaded, installed or enabled here.
      plugins: source.manifest.plugins.filter((plugin) => "path" in plugin),
      automations: [],
    },
  };
  const dependencies = await measureTemplateAddStage(
    "dependencies.plan",
    async () =>
      await buildGatewayTemplateAddPlan(dependencySource, {
        config,
        sourceMcpServers: {},
        agentId,
        admittedWorkspace: workspace,
      }),
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
      report.failures.push(dependencyFailure(dependencies, dependencySource, action, reason));
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
        await measureTemplateAddStage(
          "dependency.package.install",
          async () => await installTemplatePackages(single, installOptions),
        );
      } else {
        await measureTemplateAddStage(
          "dependency.mcp.install",
          async () =>
            await installTemplateMcpServersStateless(single, { ...installOptions, refs: [] }),
        );
        report.mcpServers.push(action.id);
      }
    } catch (error) {
      // Lost authority ends creation; any other failure is one item to report.
      options.assertCurrent?.();
      fail(coerceErrorMessage(error));
    }
  }
  return report;
}
