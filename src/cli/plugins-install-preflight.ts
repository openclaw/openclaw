// Resolve and validate plugin install requests without opening mutable runtime state.
import fs from "node:fs";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { isExactSemverVersion } from "../infra/npm-registry-spec.js";
import { resolvePluginInstallRequestContext } from "../plugins/install-config.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import { resolvePluginInstallSourcePlan } from "../plugins/install-source-plan.js";
import { resolveMarketplaceInstallShortcut } from "../plugins/marketplace.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { NON_CLAWHUB_INSTALL_FORCE_FLAG } from "./non-clawhub-install-acknowledgement.js";

export type RunPluginInstallCommandParams = {
  raw: string;
  allowInstallPolicyWarningPrompt: boolean;
  opts: InstallSafetyOverrides & {
    acceptCapabilities?: boolean;
    acknowledgeInstallPolicyWarning?: boolean;
    dangerouslyForceUnsafeInstall?: boolean;
    force?: boolean;
    enable?: boolean;
    link?: boolean;
    pin?: boolean;
    marketplace?: string;
    expectedIntegrity?: string;
  };
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
  /** Synchronous authority guard at the final plugin/config mutation. */
  beforePersistentApply?: () => void;
  applyRuntime?: import("../plugins/lifecycle.js").PluginLifecycleRuntimeApply;
};

type ResolvedPluginInstallSourcePlan = Extract<
  ReturnType<typeof resolvePluginInstallSourcePlan>,
  { ok: true }
>;

function resolveMarketplaceOptionError(opts: RunPluginInstallCommandParams["opts"]): string | null {
  if (opts.link) {
    return `--link is not supported with --marketplace. Remove --link, or install a local path with ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`;
  }
  if (opts.expectedIntegrity !== undefined) {
    return "--expected-integrity is not supported with --marketplace. Use a clawhub:<package>@<version> spec.";
  }
  if (opts.pin) {
    return `--pin is not supported with --marketplace. Use ${formatCliCommand(`openclaw plugins install <plugin> --marketplace <name> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} without --pin.`;
  }
  return null;
}

function resolveSourceOptionError(
  opts: RunPluginInstallCommandParams["opts"],
  sourcePlan: ResolvedPluginInstallSourcePlan,
): string | null {
  if (sourcePlan.request.source === "git" && opts.link) {
    return `--link is not supported with git: installs. Use ${formatCliCommand(`openclaw plugins install git:<repo>@<ref> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} for Git installs or ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)} for local paths.`;
  }
  if (sourcePlan.request.source === "git" && opts.pin) {
    return `--pin is not supported with git: installs. Pin the ref in the spec instead, for example ${formatCliCommand(`openclaw plugins install git:<repo>@<ref> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`;
  }
  if (
    opts.pin &&
    sourcePlan.request.source !== "npm" &&
    sourcePlan.request.source !== "official" &&
    sourcePlan.request.source !== "bundled"
  ) {
    return "--pin is only supported with npm registry installs.";
  }
  if (opts.link && sourcePlan.request.source !== "local") {
    return `--link requires a local path. Run ${formatCliCommand(`openclaw plugins install --link <path> ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`)}.`;
  }
  return null;
}

/**
 * Bind an operator-supplied archive digest to one exact ClawHub release. The ClawHub
 * installer hashes the downloaded archive and refuses a mismatch before extracting
 * it. npm resolves its tarball separately from the metadata it checks, so it is not
 * offered here.
 */
function applyExpectedIntegrity(
  expectedIntegrity: string,
  sourcePlan: ResolvedPluginInstallSourcePlan,
): { ok: true; sourcePlan: ResolvedPluginInstallSourcePlan } | { ok: false; error: string } {
  const request = sourcePlan.request;
  if (request.source === "clawhub") {
    const normalized = normalizeClawHubSha256Integrity(expectedIntegrity);
    if (!normalized) {
      return {
        ok: false,
        error: `--expected-integrity for a ClawHub install must be a SHA-256 digest (sha256-<base64> or 64 hex characters): ${expectedIntegrity}`,
      };
    }
    // A missing version or a tag selects whichever release is current, not the one
    // the digest describes.
    if (!request.version || !isExactSemverVersion(request.version)) {
      return {
        ok: false,
        error:
          "--expected-integrity requires an exact ClawHub version: clawhub:<package>@<version>.",
      };
    }
    return {
      ok: true,
      sourcePlan: { ...sourcePlan, request: { ...request, expectedIntegrity: normalized } },
    };
  }
  return {
    ok: false,
    error: "--expected-integrity is only supported with clawhub:<package>@<version> installs.",
  };
}

/** Complete source and option validation before acquiring the persistent lifecycle lease. */
export async function resolvePluginInstallPreflight(params: RunPluginInstallCommandParams) {
  if (!params.raw.trim()) {
    return { ok: false as const, error: "Plugin install source must not be empty." };
  }
  if (params.opts.marketplace !== undefined && !params.opts.marketplace.trim()) {
    return { ok: false as const, error: "--marketplace requires a non-empty source." };
  }

  // Linked paths confirm provenance with --force without changing their copy/update mode.
  const installMode: "install" | "update" =
    params.opts.force && !params.opts.link ? "update" : "install";
  let raw = params.raw;
  let marketplace = params.opts.marketplace;
  let sourcePlan: ResolvedPluginInstallSourcePlan | null = null;

  if (marketplace === undefined) {
    // A registered marketplace owns plugin@marketplace before npm/git source classification.
    const shorthand = await tracePluginLifecyclePhaseAsync(
      "marketplace shortcut resolution",
      () => resolveMarketplaceInstallShortcut(raw),
      { command: "install" },
    );
    if (shorthand?.ok === false) {
      return { ok: false as const, error: shorthand.error };
    }
    if (shorthand?.ok) {
      raw = shorthand.plugin;
      marketplace = shorthand.marketplaceSource;
    } else {
      const planned = resolvePluginInstallSourcePlan({
        raw,
        mode: installMode,
        link: params.opts.link,
        pin: params.opts.pin,
      });
      if (!planned.ok) {
        return planned;
      }
      sourcePlan = planned;
    }
  }

  if (marketplace && fs.existsSync(resolveUserPath(marketplace))) {
    marketplace = resolveUserPath(marketplace);
  }
  const opts = { ...params.opts, marketplace };
  const optionError = marketplace
    ? resolveMarketplaceOptionError(opts)
    : sourcePlan
      ? resolveSourceOptionError(opts, sourcePlan)
      : "Plugin install source could not be resolved.";
  if (optionError) {
    return { ok: false as const, error: optionError };
  }
  if (sourcePlan && opts.expectedIntegrity !== undefined) {
    const pinned = applyExpectedIntegrity(opts.expectedIntegrity, sourcePlan);
    if (!pinned.ok) {
      return { ok: false as const, error: pinned.error };
    }
    sourcePlan = pinned.sourcePlan;
  }

  const requestResolution = resolvePluginInstallRequestContext({
    rawSpec: raw,
    marketplace,
    source: sourcePlan?.request.source,
    localPath: sourcePlan?.localPath,
  });
  if (!requestResolution.ok) {
    return requestResolution;
  }
  const source = sourcePlan?.request.source;
  const request =
    source && ["npm-pack", "git", "clawhub", "bundled", "official"].includes(source)
      ? { ...requestResolution.request, installKind: "plugin" as const }
      : requestResolution.request;

  if (marketplace) {
    return { ok: true as const, raw, opts, installMode, request, marketplace, sourcePlan: null };
  }
  if (!sourcePlan) {
    return { ok: false as const, error: "Plugin install source could not be resolved." };
  }
  return { ok: true as const, raw, opts, installMode, request, sourcePlan };
}
