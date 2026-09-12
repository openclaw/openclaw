import { theme } from "../../packages/terminal-core/src/theme.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub.js";
import { loadConfigForInstall, PluginInstallConfigError } from "../plugins/install-config.js";
import { hasPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../runtime.js";
import { resolveClawHubInstallConfirmation } from "./clawhub-install-confirmation.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { confirmNonClawHubInstall } from "./non-clawhub-install-acknowledgement.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { createPluginInstallLogger } from "./plugins-command-helpers.js";
import { createGatewayPluginInstaller } from "./plugins-install-gateway.js";
import {
  installPluginWithHookFallback,
  resolveInstallSafetyOverrides,
} from "./plugins-install-hook-fallback.js";
import {
  resolvePluginInstallPreflight,
  type RunPluginInstallCommandParams,
} from "./plugins-install-preflight.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";

const DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING =
  "--dangerously-force-unsafe-install is deprecated and no longer affects plugin installs because built-in install-time dangerous-code scanning has been removed. Configure security.installPolicy for operator-owned install decisions.";

/** Validate intent and select the runtime owner before either process acquires its lease. */
export async function runPluginInstallCommand(params: RunPluginInstallCommandParams) {
  assertConfigWriteAllowedInCurrentMode();
  const runtime = params.runtime ?? defaultRuntime;
  const preflight = await resolvePluginInstallPreflight(params);
  if (!preflight.ok) {
    runtime.error(preflight.error);
    return runtime.exit(1);
  }
  const { raw, opts, sourcePlan } = preflight;
  if (opts.dangerouslyForceUnsafeInstall) {
    runtime.log(theme.warn(DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING));
  }
  const acknowledgment =
    sourcePlan?.acknowledgement ??
    (preflight.marketplace
      ? { sourceClass: "marketplace" as const, spec: `${raw} from ${preflight.marketplace}` }
      : undefined);
  if (
    acknowledgment &&
    !(await confirmNonClawHubInstall({
      acknowledged: opts.force,
      runtime,
      ...acknowledgment,
    }))
  ) {
    return runtime.exit(1);
  }
  let result: Awaited<ReturnType<typeof installPluginWithHookFallback>>;
  try {
    const snapshot = await loadConfigForInstall(preflight.request).catch((error: unknown) => {
      // The shipped hook-only path may still be writable when plugin config is blocked.
      if (error instanceof PluginInstallConfigError && error.blockedSnapshot) {
        return error.blockedSnapshot;
      }
      throw error;
    });
    // A Claw batch owns a lease across multiple packages; a guarded in-process
    // operation owns a callback that cannot be serialized into another process.
    const gateway =
      params.applyRuntime || params.beforePersistentApply || hasPluginLifecycleLease()
        ? null
        : await resolvePluginLifecycleGateway();
    const request = sourcePlan?.request ?? {
      source: "marketplace" as const,
      marketplace: preflight.marketplace!,
      plugin: raw,
      mode: preflight.installMode,
    };
    if (sourcePlan?.warning) {
      runtime.log(theme.warn(sourcePlan.warning));
    }
    result = await installPluginWithHookFallback({
      request:
        request.source === "clawhub"
          ? {
              ...request,
              ...(opts.expectedPluginId ? { expectedPluginId: opts.expectedPluginId } : {}),
              ...(opts.expectedIntegrity ? { expectedIntegrity: opts.expectedIntegrity } : {}),
            }
          : request,
      snapshot,
      runtime,
      clawManaged: params.clawManaged,
      applyRuntime: params.applyRuntime,
      beforePersistentApply: params.beforePersistentApply,
      invalidateRuntimeCache: params.invalidateRuntimeCache ?? true,
      ...(gateway ? { install: createGatewayPluginInstaller(gateway) } : {}),
      allowBundledFallback: sourcePlan?.allowBundledFallback,
      logger: createPluginInstallLogger(runtime),
      confirmInstall: resolveClawHubInstallConfirmation(),
      ...resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: opts.acceptCapabilities,
        action: "install",
        runtime,
      }),
      safetyOverrides: resolveInstallSafetyOverrides({
        ...opts,
        config: snapshot.config,
        ...resolveInstallPolicyWarningAcknowledgementCliOptions({
          acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
          allowPrompt: params.allowInstallPolicyWarningPrompt,
        }),
      }),
    });
  } catch (error) {
    runtime.error(formatErrorMessage(error));
    return runtime.exit(1);
  }
  if (!result.ok) {
    if (
      result.code !== CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED ||
      !result.warning?.trim()
    ) {
      runtime.error(result.error);
    }
    return runtime.exit(1);
  }
}
