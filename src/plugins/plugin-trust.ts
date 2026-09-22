import type { PluginInstallRecord } from "../config/types.plugins.js";
import { collectErrorGraphCandidates, extractErrorCode } from "../infra/errors.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

/** Captured beside the trust decision; consumers never rediscover installation facts. */
export type PluginTrust = {
  reason:
    | "bundled"
    | "trusted-official"
    | "record-missing"
    | "owner-ambiguous"
    | "origin-path"
    | "install-path-mismatch"
    | "provenance-missing"
    | "provenance-invalid";
  registryPath: string | null;
  origin: PluginOrigin | "unknown";
  installSource?: PluginInstallRecord["source"];
  installSpec?: string;
};

/** The same recorded explanation is rendered by CLI inspection and the runtime refusal. */
export function formatPluginTrustDiagnostic(trust: PluginTrust): string {
  return [
    `reason=${trust.reason}`,
    `registryPath=${JSON.stringify(trust.registryPath)}`,
    `origin=${JSON.stringify(trust.origin)}`,
    `installSource=${JSON.stringify(trust.installSource ?? null)}`,
    `installSpec=${JSON.stringify(trust.installSpec ?? null)}`,
  ].join("; ");
}

const PLUGIN_TRUST_REFUSED_CODE = "PLUGIN_TRUST_REFUSED";

export class PluginTrustRefusalError extends Error {
  readonly code = PLUGIN_TRUST_REFUSED_CODE;

  constructor(params: {
    pluginId: string;
    methodName: string;
    source: string;
    origin?: PluginOrigin;
    trust?: PluginTrust;
  }) {
    const trust = params.trust ?? {
      reason: "record-missing",
      registryPath: null,
      origin: params.origin ?? "unknown",
    };
    const remedy =
      trust.reason === "provenance-missing"
        ? "Run openclaw doctor --fix to repair proven legacy official provenance; if it cannot be verified, reinstall from the official npm package or ClawHub listing."
        : trust.reason === "record-missing"
          ? "Compare this registryPath with openclaw plugins inspect <plugin-id> --json. If the CLI and Gateway state paths differ, align the service environment; otherwise reinstall from the official npm package or ClawHub listing."
          : trust.reason === "origin-path"
            ? "Install the official npm package or ClawHub listing and remove the local override from plugins.load.paths; --link and --force do not grant trusted plugin state."
            : "Reinstall from the official npm package or ClawHub listing; local paths, archives, ambiguous ownership, and inconsistent install records do not grant trusted plugin state.";
    super(
      `${params.methodName} is only available for trusted plugins in this release. Plugin ${JSON.stringify(params.pluginId)} loaded from ${JSON.stringify(params.source)} with origin ${JSON.stringify(params.origin ?? "unknown")}; ${formatPluginTrustDiagnostic(trust)}. ${remedy}`,
    );
    this.name = "PluginTrustRefusalError";
  }
}

/** Ingress monitors and plugins can wrap the refusal before channel startup sees it. */
export function isPluginTrustRefusalError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause]).some(
    (candidate) => extractErrorCode(candidate) === PLUGIN_TRUST_REFUSED_CODE,
  );
}
