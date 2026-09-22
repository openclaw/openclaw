import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import {
  formatPluginCapabilityConsentLines,
  resolvePluginCapabilityConsentCliOptions,
} from "../../cli/plugin-capability-consent.js";
import { createPluginInstallLogger } from "../../cli/plugins-command-helpers.js";
import { resolvePendingPluginCapabilityReview } from "../../plugins/capability-consent.js";
import type { ConfigSnapshotForInstallPersist } from "../../plugins/install-config-mutation.js";
import {
  formatNonClawHubInstallWarning,
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
  type NonClawHubInstallSourceClass,
} from "../../plugins/install-provenance.js";
import { resolvePluginInstallSourcePlan } from "../../plugins/install-source-plan.js";
import type {
  PluginLifecycleRuntimeApply,
  PluginRuntimeApplication,
} from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { installManagedPlugin } from "../../plugins/management-mutations.js";

export function formatPluginCommandCapabilityConsentError(
  error: unknown,
  retryCommand: string,
): string | null {
  if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
    return null;
  }
  const review = resolvePendingPluginCapabilityReview(error.capabilityConsent.pluginId);
  if (review?.reviewToken !== error.capabilityConsent.reviewToken) {
    return null;
  }
  return [
    ...formatPluginCapabilityConsentLines(review),
    `Review these capabilities, then rerun ${stripAnsi(retryCommand)} --accept-capabilities to continue.`,
  ].join("\n");
}

function resolveNonClawHubChatInstallAcknowledgement(params: {
  force: boolean;
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): { ok: true; warning: string } | { ok: false; error: string } {
  const warning = formatNonClawHubInstallWarning(params);
  if (params.force) {
    return { ok: true, warning };
  }
  return {
    ok: false,
    error: `${warning}\nReview the source, then rerun this chat command with ${NON_CLAWHUB_INSTALL_FORCE_FLAG} to continue.`,
  };
}

export async function installPluginFromPluginsCommand(params: {
  raw: string;
  acceptCapabilities: boolean;
  force: boolean;
  snapshot: ConfigSnapshotForInstallPersist;
  applyRuntime?: PluginLifecycleRuntimeApply;
  beforePersistentApply?: () => void;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      pluginId: string;
      warnings?: readonly string[];
      application?: PluginRuntimeApplication;
    }
  | { ok: false; error: string }
> {
  const installMode = params.force ? "update" : "install";
  const plan = resolvePluginInstallSourcePlan({ raw: params.raw, mode: installMode });
  if (!plan.ok) {
    return { ok: false, error: plan.error.replace(/^Plugin path not found:/, "Path not found:") };
  }
  const acknowledgement = plan.acknowledgement
    ? resolveNonClawHubChatInstallAcknowledgement({
        force: params.force,
        ...plan.acknowledgement,
      })
    : null;
  if (acknowledgement && !acknowledgement.ok) {
    return acknowledgement;
  }
  const warnings: string[] = plan.warning ? [plan.warning] : [];
  const logger = createPluginInstallLogger();
  const clawhub = plan.request.source === "clawhub";
  let result: Awaited<ReturnType<typeof installManagedPlugin>>;
  try {
    result = await installManagedPlugin({
      request: plan.request,
      applyRuntime: params.applyRuntime,
      beforePersistentApply: params.beforePersistentApply,
      signal: params.signal,
      snapshot: params.snapshot,
      ...resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: params.acceptCapabilities,
        action: "install",
        allowPrompt: false,
      }),
      logger: clawhub
        ? {
            info: logger.info,
            warn: (message) => {
              warnings.push(stripAnsi(message));
              logger.warn(message);
            },
            terminalLinks: false,
          }
        : logger,
    });
  } catch (error) {
    const forceFlag = params.force ? " --force" : "";
    const consentError = formatPluginCommandCapabilityConsentError(
      error,
      `/plugins install ${params.raw}${forceFlag}`,
    );
    if (consentError) {
      return { ok: false, error: consentError };
    }
    if (error instanceof ManagedPluginLifecycleError && error.installRejected) {
      return { ok: false, error: [error.warning, error.message].filter(Boolean).join(" ") };
    }
    throw error;
  }
  warnings.push(...(result.warnings ?? []));
  if (acknowledgement?.ok) {
    warnings.push(acknowledgement.warning);
  }
  return {
    ok: true,
    pluginId: result.plugin.id,
    ...(result.application ? { application: result.application } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
