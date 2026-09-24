// Terminal presentation for ClawHub plugin installation.
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatTerminalLink } from "../../packages/terminal-core/src/terminal-link.js";
import { resolveClawHubBaseUrl } from "../infra/clawhub-client.js";
import type {
  ClawHubPackageCompatibility,
  ClawHubPackageDetail,
} from "../infra/clawhub-packages.js";
import type { PluginInstallLogger as BasePluginInstallLogger } from "./install-types.js";

export type PluginInstallLogger = BasePluginInstallLogger & {
  terminalLinks?: boolean;
};

export function formatClawHubSpecifier(params: { name: string; version?: string }): string {
  return `clawhub:${params.name}${params.version ? `@${params.version}` : ""}`;
}

function encodeClawHubPackagePath(packageName: string): string {
  return packageName
    .split("/")
    .map((part) => encodeURIComponent(part).replaceAll("%40", "@"))
    .join("/");
}

function resolveClawHubPluginUrl(params: { baseUrl?: string; packageName: string }): string {
  return `${resolveClawHubBaseUrl(params.baseUrl)}/plugins/${encodeClawHubPackagePath(params.packageName)}`;
}

function padRight(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

export function formatClawHubReleaseLabel(packageName: string, version: string): string {
  return `${sanitizeTerminalText(packageName)}@${sanitizeTerminalText(version)}`;
}

export function logClawHubPackageSummary(params: {
  detail: ClawHubPackageDetail;
  version: string;
  compatibility?: ClawHubPackageCompatibility | null;
  baseUrl?: string;
  logger?: PluginInstallLogger;
}) {
  const pkg = params.detail.package;
  if (!pkg) {
    return;
  }
  const familyLabel = pkg.family === "code-plugin" ? "plugin" : pkg.family;
  const compatibilityParts = [
    params.compatibility?.pluginApiRange
      ? `pluginApi ${params.compatibility.pluginApiRange}`
      : null,
    params.compatibility?.minGatewayVersion
      ? `minGateway ${params.compatibility.minGatewayVersion}`
      : null,
  ].filter(Boolean);
  const pluginUrl = sanitizeTerminalText(
    resolveClawHubPluginUrl({ baseUrl: params.baseUrl, packageName: pkg.name }),
  );
  params.logger?.info?.(
    [
      `  ${padRight("Package", 9)} ${formatClawHubReleaseLabel(pkg.name, params.version)}`,
      `  ${padRight("Type", 9)} ${familyLabel}`,
      compatibilityParts.length > 0
        ? `  ${padRight("Requires", 9)} ${compatibilityParts.join(" · ")}`
        : null,
      `  ${padRight("ClawHub", 9)} ${formatTerminalLink("view plugin", pluginUrl, {
        fallback: pluginUrl,
        ...(params.logger?.terminalLinks !== undefined
          ? { force: params.logger.terminalLinks }
          : {}),
      })}`,
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );
}
