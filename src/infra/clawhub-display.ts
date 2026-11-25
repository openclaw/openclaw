import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";

export function encodeClawHubPackagePath(packageName: string): string {
  return packageName
    .split("/")
    .map((part) => encodeURIComponent(part).replaceAll("%40", "@"))
    .join("/");
}

export function formatClawHubReleaseLabel(packageName: string, version: string): string {
  return `${sanitizeTerminalText(packageName)}@${sanitizeTerminalText(version)}`;
}
