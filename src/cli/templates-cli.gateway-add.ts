import { existsSync } from "node:fs";
import type {
  TemplateLifecyclePlanResult,
  TemplatePluginAcknowledgement,
  TemplateSkillAcknowledgement,
  TemplatesCatalogSearchResult,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import type { GatewayTemplateAddApplyResult } from "../templates/gateway-add-apply.js";
import { isCanonicalClawHubPackageName, isExactSemVer } from "../templates/schema-portability.js";
import type { OwnerRequest } from "./local-state-owner.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { promptYesNo } from "./prompt.js";
import { emitTemplateFailure } from "./templates-cli-output.js";
import type { TemplatesAddOptions } from "./templates-cli.js";

/** The running owner resolves, reviews and installs registry sources; it never reads CLI paths. */
export async function runTemplatesAddThroughOwner(
  sourcePath: string,
  opts: TemplatesAddOptions,
  requestOwner: OwnerRequest,
): Promise<void> {
  if (existsSync(sourcePath) || !isCanonicalClawHubPackageName(sourcePath)) {
    throw new Error(
      "Local Template files require exclusive offline state ownership; stop the Gateway before Add, or preview with --dry-run. Add a published ClawHub package by name to use the running Gateway.",
    );
  }
  if (opts.workspace !== undefined) {
    throw new Error(
      "The running Gateway chooses the new Template workspace. Omit --workspace to Add this ClawHub package, or use --dry-run to preview a local workspace override.",
    );
  }
  const catalog = await requestOwner<TemplatesCatalogSearchResult>("templates.catalog.search", {
    query: sourcePath,
    limit: 100,
  });
  const matches = catalog.entries.filter((entry) => entry.packageName === sourcePath);
  const version = matches.length === 1 ? matches[0]?.latestVersion : undefined;
  if (!version || !isExactSemVer(version)) {
    throw new Error(
      "ClawHub did not identify one exact published Template version. Search the catalog and retry.",
    );
  }
  const input = {
    source: { packageName: sourcePath, version },
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
  };
  const plan = await requestOwner<TemplateLifecyclePlanResult>("templates.add.plan", input);
  if (plan.operation !== "add" || !plan.planIntegrity) {
    throw new Error(
      "Gateway did not return a bound Template Add review. Update the Gateway and retry.",
    );
  }
  if (plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      for (const blocker of plan.blockers) {
        runtime.error(redactSensitiveText(sanitizeTerminalText(blocker.message)));
      }
    }
    runtime.exit(1);
    return;
  }
  const plugins = plan.pluginReviews.filter((review) => review.ownerAction === "install");
  const warnings = [
    ...(plan.trustWarning ? [plan.trustWarning] : []),
    ...plugins.flatMap((review) =>
      review.riskWarning ? [`${review.pluginId}: ${review.riskWarning}`] : [],
    ),
    ...plan.skillReviews.map(
      (review) => `${"path" in review ? review.path : review.ref}: ${review.riskWarning}`,
    ),
  ];
  let riskApproved = Boolean(opts.acknowledgeClawhubRisk);
  if (plan.riskAcknowledgementRequired || warnings.length > 0) {
    if (!opts.json) {
      for (const warning of warnings) {
        runtime.log(redactSensitiveText(sanitizeTerminalText(warning)));
      }
    }
    if (!riskApproved && !opts.json && process.stdin.isTTY && process.stdout.isTTY) {
      riskApproved = await promptYesNo(
        "Acknowledge these exact Template and dependency trust warnings?",
      );
    }
    if (!riskApproved) {
      const message =
        "Template and dependency trust warnings require --acknowledge-clawhub-risk or interactive confirmation.";
      emitTemplateFailure(opts.json, message, {
        status: "failed",
        error: { code: "clawhub_risk_acknowledgement_required", message },
        warnings,
      });
      return;
    }
  }
  const { onCapabilityConsent } = resolvePluginCapabilityConsentCliOptions({
    action: "install",
    acceptCapabilities: opts.acceptCapabilities,
    allowPrompt: !opts.json,
    runtime,
  });
  const acknowledgeCapabilities: TemplatePluginAcknowledgement[] = [];
  for (const review of plugins) {
    for (const [pluginId, grants] of Object.entries(review.capabilityGrantsByPluginId)) {
      const consent = await onCapabilityConsent?.({
        pluginId,
        name: pluginId,
        reviewToken: review.reviewToken,
        declared: review.declaredCapabilities,
        grants,
        source:
          review.source === "bundled"
            ? { kind: "bundled", spec: review.path, integrity: review.digest }
            : { kind: "clawhub", packageName: review.ref, integrity: review.integrity },
        ...(review.source === "clawhub" ? { version: review.version } : {}),
      });
      if (consent?.reviewToken !== review.reviewToken) {
        const message =
          "Plugin capabilities require --accept-capabilities or interactive confirmation.";
        emitTemplateFailure(opts.json, message, {
          status: "failed",
          error: { code: "plugin_capability_consent_required", message },
        });
        return;
      }
    }
    acknowledgeCapabilities.push({
      actionId: review.actionId,
      pluginId: review.pluginId,
      reviewToken: review.reviewToken,
      capabilityGrants: review.capabilityGrants,
      capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
      ...(review.riskWarning ? { acknowledgeRiskWarning: true } : {}),
    });
  }
  const acknowledgeSkillWarnings = plan.skillReviews.map((review): TemplateSkillAcknowledgement =>
    "path" in review
      ? {
          actionId: review.actionId,
          source: "bundled",
          path: review.path,
          digest: review.digest,
          reviewToken: review.reviewToken,
          acknowledgeRiskWarning: true,
        }
      : {
          actionId: review.actionId,
          source: "clawhub",
          ref: review.ref,
          reviewToken: review.reviewToken,
          acknowledgeRiskWarning: true,
        },
  );
  const result = await requestOwner<GatewayTemplateAddApplyResult>("templates.add.apply", {
    ...input,
    planIntegrity: plan.planIntegrity,
    ...(riskApproved ? { acknowledgeClawHubRisk: true } : {}),
    acknowledgeCapabilities,
    acknowledgeSkillWarnings,
  });
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(
      result.status === "complete"
        ? `Added agent: ${sanitizeTerminalText(result.agentId)}`
        : `Template Add partial for agent ${sanitizeTerminalText(result.agentId)}. Inspect reported Gateway state before retrying.`,
    );
    if (result.error) {
      runtime.error(redactSensitiveText(sanitizeTerminalText(result.error.message)));
    }
  }
  if (result.status !== "complete") {
    runtime.exit(1);
  }
}
