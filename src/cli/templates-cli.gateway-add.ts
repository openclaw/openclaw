import { existsSync } from "node:fs";
import path from "node:path";
import type {
  TemplateLifecyclePlanResult,
  TemplatePluginAcknowledgement,
  TemplateSkillAcknowledgement,
  TemplatesCatalogSearchResult,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import type { GatewayTemplateAddApplyResult } from "../templates/gateway-add-result.js";
import {
  clawHubTemplateRef,
  isCanonicalClawHubPackageName,
  isExactSemVer,
} from "../templates/schema-portability.js";
import type { OwnerRequest } from "./local-state-owner.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { promptYesNo } from "./prompt.js";
import { emitTemplateFailure } from "./templates-cli-output.js";
import type { TemplatesAddOptions } from "./templates-cli.js";

/** The running owner reviews and installs the selected source, retaining its consent contract. */
export async function runTemplatesAddThroughOwner(
  sourcePath: string,
  opts: TemplatesAddOptions,
  requestOwner: OwnerRequest,
): Promise<void> {
  const local = existsSync(sourcePath) || !isCanonicalClawHubPackageName(sourcePath);
  if (opts.workspace !== undefined) {
    throw new Error(
      "The running Gateway chooses the new Template workspace. Omit --workspace to Add this ClawHub package, or use --dry-run to preview a local workspace override.",
    );
  }
  const resolveSource = async () => {
    if (local) {
      return { kind: "local" as const, path: path.resolve(sourcePath) };
    }
    const catalog = await requestOwner<TemplatesCatalogSearchResult>("templates.catalog.search", {
      query: sourcePath,
      limit: 100,
    });
    // An exact package name wins; `@publisher/slug` also names that publisher's unscoped package.
    const exact = catalog.entries.filter((entry) => entry.packageName === sourcePath);
    const matches =
      exact.length > 0
        ? exact
        : catalog.entries.filter(
            (entry) => clawHubTemplateRef(entry.packageName, entry.ownerHandle) === sourcePath,
          );
    const match = matches.length === 1 ? matches[0] : undefined;
    const version = match?.latestVersion;
    if (!match || !version || !isExactSemVer(version)) {
      throw new Error(
        "ClawHub did not identify one exact published Template version. Search the catalog and retry.",
      );
    }
    return { packageName: match.packageName, version };
  };
  const input = {
    source: await resolveSource(),
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
    agentId: plan.target.agentId,
    planIntegrity: plan.planIntegrity,
    ...(riskApproved ? { acknowledgeClawHubRisk: true } : {}),
    acknowledgeCapabilities,
    acknowledgeSkillWarnings,
  });
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    const agentId = sanitizeTerminalText(result.agentId);
    runtime.log(
      result.status === "complete"
        ? `Added agent: ${agentId}`
        : result.initializationPending
          ? `Template Add partial for agent ${agentId}. Rerun with --agent-id ${agentId} to continue its setup.`
          : `Template Add partial for agent ${agentId}. Inspect reported Gateway state before retrying.`,
    );
    if (result.error) {
      runtime.error(redactSensitiveText(sanitizeTerminalText(result.error.message)));
    }
  }
  if (result.status !== "complete") {
    runtime.exit(1);
  }
}
