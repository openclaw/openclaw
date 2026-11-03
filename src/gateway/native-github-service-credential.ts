import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBundledPluginEnabled } from "../plugins/config-state.js";
import {
  assertSecretOwnerAvailable,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import {
  readNativeGitHubApiConfig,
  resolveConfiguredGitHubHost,
} from "./native-github-host-realm.js";

function readNativeGitHubServiceConfig(config?: OpenClawConfig | null) {
  const service = readNativeGitHubApiConfig(config).service;
  if (!isRecord(service)) {
    return undefined;
  }
  return {
    token: service.token,
    host: typeof service.host === "string" ? service.host : undefined,
  };
}

/** Host credential selection uses canonical config and degradation state. */
export function githubApiToken(
  env: NodeJS.ProcessEnv = process.env,
  config: OpenClawConfig | null = getRuntimeConfigSnapshot(),
  host?: string,
): string | undefined {
  const selectedHost = host ?? resolveConfiguredGitHubHost(config);
  const service = readNativeGitHubServiceConfig(config);
  const configured = service?.token;
  const credentialHost = service?.host?.trim().toLowerCase() || "github.com";
  if (configured !== undefined && (host === undefined || credentialHost === selectedHost)) {
    if (credentialHost !== selectedHost) {
      throw new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "plugins.entries.github-repositories.config.service.token",
        state: "unavailable",
        paths: ["plugins.entries.github-repositories.config.service.host"],
        refKeys: [],
        reason:
          "service credential host does not match plugins.entries.github-repositories.config.host",
      });
    }
    const enabled = isBundledPluginEnabled(config ?? {}, "github-repositories");
    // Independent sign-in must not activate disabled plugin SecretRefs.
    if (enabled || typeof configured === "string") {
      if (enabled) {
        assertSecretOwnerAvailable(
          "capability",
          "plugins.entries.github-repositories.config.service.token",
        );
      }
      const token = typeof configured === "string" ? configured.trim() : "";
      if (!token) {
        throw new SecretSurfaceUnavailableError({
          ownerKind: "capability",
          ownerId: "plugins.entries.github-repositories.config.service.token",
          state: "unavailable",
          paths: ["plugins.entries.github-repositories.config.service.token"],
          refKeys: [],
          reason: "secret reference was not materialized by the active runtime",
        });
      }
      return token;
    }
  }
  return selectedHost === "github.com"
    ? env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined
    : undefined;
}

export function hasConfiguredGitHubApiCredential(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
): boolean {
  const service = readNativeGitHubServiceConfig(config);
  const host = resolveConfiguredGitHubHost(config);
  return (
    (service?.token !== undefined &&
      (service.host?.trim().toLowerCase() || "github.com") === host) ||
    (host === "github.com" && Boolean(env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()))
  );
}
