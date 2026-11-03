// Native profile/receipt realms remain readable without activating repository integration.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const GITHUB_PUBLIC_HOST = "github.com";
const GITHUB_PUBLIC_API_BASE_URL = "https://api.github.com";
const CONFIG_PATH = "plugins.entries.github-repositories.config";

/** Canonical configuration only; this projection never activates an optional plugin. */
export function readNativeGitHubApiConfig(config?: OpenClawConfig | null): Record<string, unknown> {
  const configured = config?.plugins?.entries?.["github-repositories"]?.config;
  return isRecord(configured) ? configured : {};
}

export function resolveConfiguredGitHubHost(config?: OpenClawConfig | null): string {
  const configuredHost = readNativeGitHubApiConfig(config).host;
  if (configuredHost !== undefined && typeof configuredHost !== "string") {
    throw new Error(`${CONFIG_PATH}.host must be a string`);
  }
  const host = configuredHost?.trim().toLowerCase() || GITHUB_PUBLIC_HOST;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes("..")) {
    throw new Error("plugins.entries.github-repositories.config.host must be a hostname");
  }
  return host;
}

export function resolveConfiguredGitHubApiBaseUrl(config?: OpenClawConfig | null): string {
  const configuredBaseUrl = readNativeGitHubApiConfig(config).apiBaseUrl;
  if (configuredBaseUrl !== undefined && typeof configuredBaseUrl !== "string") {
    throw new Error(`${CONFIG_PATH}.apiBaseUrl must be a string`);
  }
  const raw = configuredBaseUrl?.trim() || GITHUB_PUBLIC_API_BASE_URL;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["/", "", "/api/v3", "/api/v3/"].includes(parsed.pathname)
  ) {
    throw new Error(
      "plugins.entries.github-repositories.config.apiBaseUrl must be an HTTPS GitHub API base URL",
    );
  }
  const host = resolveConfiguredGitHubHost(config);
  const cloudApi = parsed.hostname === `api.${host}` && parsed.pathname === "/";
  const serverApi = parsed.hostname === host && ["/api/v3", "/api/v3/"].includes(parsed.pathname);
  if (!cloudApi && !serverApi) {
    throw new Error(
      "plugins.entries.github-repositories.config.apiBaseUrl must match the configured GitHub host",
    );
  }
  return parsed.origin + (parsed.pathname.startsWith("/api/v3") ? "/api/v3" : "");
}

export function resolveGitHubHost(): string {
  return resolveConfiguredGitHubHost(getRuntimeConfigSnapshot());
}

export function resolveGitHubApiBaseUrl(): string {
  return resolveConfiguredGitHubApiBaseUrl(getRuntimeConfigSnapshot());
}
