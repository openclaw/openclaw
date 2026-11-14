import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { CronModelImpactResult } from "../../../packages/gateway-protocol/src/schema/cron-model-impact.js";
import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shellEscape } from "../../shared/shell-quote.js";
import { updateDefaultModelPrimaryConfig } from "./shared.js";

async function previewAutomationImpact(
  selection: { config: OpenClawConfig; configPath: string; model: string },
  runtime: RuntimeEnv,
) {
  const guidance = terminalText`Review with ${formatCliCommand(`openclaw automations model-impact --model ${shellEscape(selection.model)}`)} on the Gateway that uses this config. This advisory does not block the save.`;
  const unknown = (reason: string) =>
    runtime.error?.(`Automation impact: unknown. ${reason}\n${guidance}`);
  try {
    const { callGateway, isImplicitLocalGatewayTarget } = await import("../../gateway/call.js");
    if (!(await isImplicitLocalGatewayTarget({ config: selection.config }))) {
      unknown(
        "models set edits local config; the selected remote or URL-overridden Gateway cannot assess that local change.",
      );
      return;
    }
    const { readActiveGatewayLockIdentity } = await import("../../infra/gateway-lock.js");
    const owner = await readActiveGatewayLockIdentity({ requireInspection: true });
    if (!owner) {
      unknown("No running local Gateway was found for this state directory.");
      return;
    }
    let impact: CronModelImpactResult | undefined;
    // A local listener alone does not bind the config: one state root can be
    // opened with another config path. Inspect both on the same connection.
    const gatewayConfig = await callGateway<{ path: string; valid: boolean }>({
      config: selection.config,
      configPath: selection.configPath,
      localPortOverride: owner.port,
      ignoreEnvUrlOverride: true,
      method: "config.get",
      params: {},
      requiredMethods: ["config.get", "cron.modelImpact"],
      scopes: ["operator.read"],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      allowLocalBackendAuthNone: true,
      sharedStateMode: "read-only",
      timeoutMs: 5_000,
      onResponse: async (request) => {
        impact = await request<CronModelImpactResult>("cron.modelImpact", {
          model: selection.model,
        });
      },
    });
    const { resolveIdentityPathViaExistingAncestorSync } =
      await import("../../infra/boundary-path.js");
    if (
      !gatewayConfig.valid ||
      resolveIdentityPathViaExistingAncestorSync(gatewayConfig.path) !==
        resolveIdentityPathViaExistingAncestorSync(selection.configPath)
    ) {
      unknown("The running Gateway does not have a valid snapshot of this local config path.");
      return;
    }
    if (!impact) {
      unknown("The Gateway returned no automation assessment.");
      return;
    }
    const changed = impact.jobs.filter((job) => job.changed);
    const blocked = impact.jobs.filter((job) => job.status === "blocked");
    const unresolved = impact.jobs.filter((job) => job.status === "unknown");
    const lines = [
      `Automation impact before save (local Gateway snapshot): ${impact.jobs.length} visible jobs, ${changed.length} model changes, ${blocked.length} blocked, ${unresolved.length} unknown.`,
      "Advisory only: config and jobs can change; no model calls were made. No known blocker is not a compatibility guarantee.",
    ];
    const issueLine = (issue: CronModelImpactResult["issues"][number]) =>
      terminalText`  ${issue.severity}: ${issue.message}${issue.recovery ? ` Next: ${issue.recovery}` : ""}`;
    lines.push(...impact.issues.map(issueLine));
    for (const job of impact.jobs) {
      if (!job.changed && job.status !== "blocked" && job.status !== "unknown") {
        continue;
      }
      lines.push(
        terminalText`- ${job.name} (${job.id}, ${job.enabled ? "enabled" : "disabled"}, agent ${job.effectiveAgentId ?? "unknown"}): ${job.before.model ?? "unknown"} [${job.before.source ?? "unknown"}] -> ${job.after.model ?? "unknown"} [${job.after.source ?? "unknown"}]; ${job.status}`,
        ...job.issues.map(issueLine),
      );
    }
    lines.push(guidance);
    runtime.error?.(lines.join("\n"));
  } catch {
    // Assessment failure must neither certify compatibility nor turn this
    // existing offline config editor into a Gateway-dependent mutation.
    unknown(
      "The local Gateway assessment is unavailable. Check Gateway status, access, and support for cron.modelImpact.",
    );
  }
}

export async function modelsSetCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
  field: "model" | "imageModel" = "model",
) {
  const repair =
    field === "model"
      ? (await import("../runtime-plugin-install.js")).repairModelSelectionRuntimePlugins
      : undefined;
  const { updated, warning: catalogWarning } = await updateDefaultModelPrimaryConfig({
    modelRaw,
    field,
    beforeSave:
      field === "model" ? (selection) => previewAutomationImpact(selection, runtime) : undefined,
  });
  if (catalogWarning) {
    runtime.error?.(catalogWarning);
  }
  const selectedModel =
    resolveAgentModelPrimaryValue(updated.agents?.defaults?.[field]) ?? modelRaw;
  const warnings = repair ? await repair({ cfg: updated, model: selectedModel }) : [];
  for (const warning of warnings) {
    runtime.error?.(warning);
  }

  logConfigUpdated(runtime);
  runtime.log(`${field === "model" ? "Default" : "Image"} model: ${selectedModel}`);
}
