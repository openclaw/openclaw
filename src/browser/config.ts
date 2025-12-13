import type { BrowserConfig } from "../config/config.js";
import {
  DEFAULT_CLAWD_BROWSER_CDP_PORT,
  DEFAULT_CLAWD_BROWSER_COLOR,
  DEFAULT_CLAWD_BROWSER_CONTROL_URL,
  DEFAULT_CLAWD_BROWSER_ENABLED,
} from "./constants.js";

export type ResolvedBrowserConfig = {
  enabled: boolean;
  controlUrl: string;
  controlHost: string;
  controlPort: number;
  cdpPort: number;
  color: string;
  headless: boolean;
  attachOnly: boolean;
};

function isLoopbackHost(host: string) {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function normalizeHexColor(raw: string | undefined) {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_CLAWD_BROWSER_COLOR;
  const normalized = value.startsWith("#") ? value : `#${value}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return DEFAULT_CLAWD_BROWSER_COLOR;
  return normalized.toUpperCase();
}

export function resolveBrowserConfig(
  cfg: BrowserConfig | undefined,
): ResolvedBrowserConfig {
  const enabled = cfg?.enabled ?? DEFAULT_CLAWD_BROWSER_ENABLED;
  const controlUrl = (
    cfg?.controlUrl ?? DEFAULT_CLAWD_BROWSER_CONTROL_URL
  ).trim();
  const parsed = new URL(controlUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `browser.controlUrl must be http(s), got: ${parsed.protocol.replace(":", "")}`,
    );
  }

  const port =
    parsed.port && Number.parseInt(parsed.port, 10) > 0
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`browser.controlUrl has invalid port: ${parsed.port}`);
  }

  const cdpPort = DEFAULT_CLAWD_BROWSER_CDP_PORT;
  if (port === cdpPort) {
    throw new Error(
      `browser.controlUrl port (${port}) must not equal CDP port (${cdpPort})`,
    );
  }

  const headless = cfg?.headless === true;
  const attachOnly = cfg?.attachOnly === true;

  return {
    enabled,
    controlUrl: parsed.toString().replace(/\/$/, ""),
    controlHost: parsed.hostname,
    controlPort: port,
    cdpPort,
    color: normalizeHexColor(cfg?.color),
    headless,
    attachOnly,
  };
}

export function shouldStartLocalBrowserServer(resolved: ResolvedBrowserConfig) {
  return isLoopbackHost(resolved.controlHost);
}
