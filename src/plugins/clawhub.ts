import fs from "node:fs/promises";
import path from "node:path";
import {
  downloadClawHubPackageArchive,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  parseClawHubPluginSpec,
  resolveLatestVersionFromPackage,
  satisfiesGatewayMinimum,
  satisfiesPluginApiRange,
  type ClawHubPackageChannel,
  type ClawHubPackageDetail,
  type ClawHubPackageFamily,
} from "../infra/clawhub.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { installPluginFromArchive, type InstallPluginResult } from "./install.js";

export const OPENCLAW_PLUGIN_API_VERSION = "1.2.0";

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ClawHubPluginInstallRecordFields = {
  source: "clawhub";
  clawhubUrl: string;
  clawhubPackage: string;
  clawhubFamily: Exclude<ClawHubPackageFamily, "skill">;
  clawhubChannel?: ClawHubPackageChannel;
  version?: string;
  integrity?: string;
  resolvedAt?: string;
  installedAt?: string;
};

export function formatClawHubSpecifier(params: { name: string; version?: string }): string {
  return `clawhub:${params.name}${params.version ? `@${params.version}` : ""}`;
}

function resolveRequestedVersion(params: {
  detail: ClawHubPackageDetail;
  requestedVersion?: string;
}): string | null {
  if (params.requestedVersion) {
    return params.requestedVersion;
  }
  return resolveLatestVersionFromPackage(params.detail);
}

async function resolveCompatiblePackageVersion(params: {
  detail: ClawHubPackageDetail;
  requestedVersion?: string;
  baseUrl?: string;
  token?: string;
}): Promise<{
  version: string;
  compatibility?: {
    pluginApiRange?: string;
    minGatewayVersion?: string;
  } | null;
}> {
  const version = resolveRequestedVersion(params);
  if (!version) {
    throw new Error(
      `ClawHub package "${params.detail.package?.name ?? "unknown"}" has no installable version.`,
    );
  }
  const versionDetail = await fetchClawHubPackageVersion({
    name: params.detail.package?.name ?? "",
    version,
    baseUrl: params.baseUrl,
    token: params.token,
  });
  return {
    version,
    compatibility:
      versionDetail.version?.compatibility ?? params.detail.package?.compatibility ?? null,
  };
}

function validateClawHubPluginPackage(params: {
  detail: ClawHubPackageDetail;
  compatibility?: {
    pluginApiRange?: string;
    minGatewayVersion?: string;
  } | null;
}) {
  const pkg = params.detail.package;
  if (!pkg) {
    throw new Error("Package not found on ClawHub.");
  }
  if (pkg.family === "skill") {
    throw new Error(`"${pkg.name}" is a skill. Use "openclaw skills install ${pkg.name}" instead.`);
  }
  if (pkg.family !== "code-plugin" && pkg.family !== "bundle-plugin") {
    throw new Error(`Unsupported ClawHub package family: ${String(pkg.family)}`);
  }
  if (pkg.channel === "private") {
    throw new Error(`"${pkg.name}" is private on ClawHub and cannot be installed anonymously.`);
  }

  const compatibility = params.compatibility;
  if (
    compatibility?.pluginApiRange &&
    !satisfiesPluginApiRange(OPENCLAW_PLUGIN_API_VERSION, compatibility.pluginApiRange)
  ) {
    throw new Error(
      `Plugin "${pkg.name}" requires plugin API ${compatibility.pluginApiRange}, but this OpenClaw runtime exposes ${OPENCLAW_PLUGIN_API_VERSION}.`,
    );
  }

  const runtimeVersion = resolveRuntimeServiceVersion();
  if (
    compatibility?.minGatewayVersion &&
    !satisfiesGatewayMinimum(runtimeVersion, compatibility.minGatewayVersion)
  ) {
    throw new Error(
      `Plugin "${pkg.name}" requires OpenClaw >=${compatibility.minGatewayVersion}, but this host is ${runtimeVersion}.`,
    );
  }
}

function logClawHubPackageSummary(params: {
  detail: ClawHubPackageDetail;
  version: string;
  logger?: PluginInstallLogger;
}) {
  const pkg = params.detail.package;
  if (!pkg) {
    return;
  }
  const verification = pkg.verification?.tier ? ` verification=${pkg.verification.tier}` : "";
  params.logger?.info?.(
    `ClawHub ${pkg.family} ${pkg.name}@${params.version} channel=${pkg.channel}${verification}`,
  );
  const compatibilityParts = [
    pkg.compatibility?.pluginApiRange ? `pluginApi=${pkg.compatibility.pluginApiRange}` : null,
    pkg.compatibility?.minGatewayVersion
      ? `minGateway=${pkg.compatibility.minGatewayVersion}`
      : null,
  ].filter(Boolean);
  if (compatibilityParts.length > 0) {
    params.logger?.info?.(`Compatibility: ${compatibilityParts.join(" ")}`);
  }
  if (pkg.channel !== "official") {
    params.logger?.warn?.(
      `ClawHub package "${pkg.name}" is ${pkg.channel}; review source and verification before enabling.`,
    );
  }
}

export async function installPluginFromClawHub(params: {
  spec: string;
  baseUrl?: string;
  token?: string;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<
  | ({
      ok: true;
    } & Extract<InstallPluginResult, { ok: true }> & {
        clawhub: ClawHubPluginInstallRecordFields;
        packageName: string;
      })
  | Extract<InstallPluginResult, { ok: false }>
> {
  const parsed = parseClawHubPluginSpec(params.spec);
  if (!parsed?.name) {
    return {
      ok: false,
      error: `invalid ClawHub plugin spec: ${params.spec}`,
    };
  }

  params.logger?.info?.(`Resolving ${formatClawHubSpecifier(parsed)}…`);
  const detail = await fetchClawHubPackageDetail({
    name: parsed.name,
    baseUrl: params.baseUrl,
    token: params.token,
  });
  const versionState = await resolveCompatiblePackageVersion({
    detail,
    requestedVersion: parsed.version,
    baseUrl: params.baseUrl,
    token: params.token,
  });
  validateClawHubPluginPackage({
    detail,
    compatibility: versionState.compatibility,
  });
  logClawHubPackageSummary({
    detail,
    version: versionState.version,
    logger: params.logger,
  });

  const archive = await downloadClawHubPackageArchive({
    name: parsed.name,
    version: versionState.version,
    baseUrl: params.baseUrl,
    token: params.token,
  });
  try {
    params.logger?.info?.(
      `Downloading ${detail.package?.family === "bundle-plugin" ? "bundle" : "plugin"} ${parsed.name}@${versionState.version} from ClawHub…`,
    );
    const installResult = await installPluginFromArchive({
      archivePath: archive.archivePath,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
    });
    if (!installResult.ok) {
      return installResult;
    }

    const pkg = detail.package!;
    const clawhubFamily =
      pkg.family === "code-plugin" || pkg.family === "bundle-plugin" ? pkg.family : null;
    if (!clawhubFamily) {
      throw new Error(`Unsupported ClawHub package family: ${pkg.family}`);
    }
    return {
      ...installResult,
      packageName: parsed.name,
      clawhub: {
        source: "clawhub",
        clawhubUrl:
          params.baseUrl?.trim() ||
          process.env.OPENCLAW_CLAWHUB_URL?.trim() ||
          "https://clawhub.ai",
        clawhubPackage: parsed.name,
        clawhubFamily,
        clawhubChannel: pkg.channel,
        version: installResult.version ?? versionState.version,
        integrity: archive.integrity,
        resolvedAt: new Date().toISOString(),
      },
    };
  } finally {
    await fs.rm(archive.archivePath, { force: true }).catch(() => undefined);
    await fs
      .rm(path.dirname(archive.archivePath), { recursive: true, force: true })
      .catch(() => undefined);
  }
}
