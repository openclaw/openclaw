import type { GmailHookOverrides, GmailHookRuntimeConfig } from "../config/gmail-hook.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { loadBundledPluginPublicSurfaceModuleSyncCore } from "../plugin-sdk/facade-loader.js";

type GmailApi = {
  GMAIL_INSECURE_TOKEN_ARGS_WARNING: string;
  normalizeHooksPath(raw?: string): string;
  normalizeServePath(raw?: string): string;
  buildDefaultHookUrl(hooksPath?: string, port?: number): string;
  buildTopicPath(projectId: string, topicName: string): string;
  parseTopicPath(topic: string): { projectId: string; topicName: string } | null;
  buildGogWatchStartArgs(
    topic: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
  ): string[];
  mergeHookPresets(existing: string[] | undefined, preset: string): string[];
  resolveGmailHookRuntimeConfig(
    config: OpenClawConfig,
    overrides: GmailHookOverrides,
  ): { ok: true; value: GmailHookRuntimeConfig } | { ok: false; error: string };
};

export type GogInspection = {
  executable: string | undefined;
  support: "supported" | "unsupported" | "indeterminate";
};
type GogOptions = { env?: NodeJS.ProcessEnv; signal?: AbortSignal };
type GogUpgrade = { eligible: true; brew: string; formula: string; executable: string };

type GmailRuntime = {
  ensureDependency(binary: string, brewArgs: string[]): Promise<void>;
  ensureGcloudAuth(): Promise<void>;
  ensureSubscription(
    project: string,
    subscription: string,
    topic: string,
    endpoint: string,
  ): Promise<void>;
  ensureTailscaleEndpoint(
    params: GmailHookRuntimeConfig["tailscale"] & {
      port?: number;
      token?: string;
      signal?: AbortSignal;
    },
  ): Promise<string>;
  ensureTopic(project: string, topic: string): Promise<void>;
  inspectGog(options: GogOptions): Promise<GogInspection>;
  inspectGogUpgrade(
    inspection: GogInspection,
    options: GogOptions,
  ): Promise<GogUpgrade | { eligible: false; reason: string }>;
  upgradeGog(
    upgrade: GogUpgrade,
    options: GogOptions,
  ): Promise<{ inspection: GogInspection; message: string }>;
  resolveProjectIdFromGogCredentials(): Promise<string | null>;
  runGcloud(args: string[]): Promise<unknown>;
  startGmailWatcherService(
    config: GmailHookRuntimeConfig,
    options: {
      scheduler: GatewayScheduler;
      signal: AbortSignal;
      prepareGog(inspection: GogInspection, signal?: AbortSignal): Promise<GogInspection>;
    },
  ): Promise<{ started: boolean; reason?: string }>;
  stopGmailWatcher(): Promise<void>;
};

export function loadGmailApi(): GmailApi {
  return loadBundledPluginPublicSurfaceModuleSyncCore<GmailApi>({
    dirName: "gmail",
    artifactBasename: "api.js",
  });
}

export function loadGmailRuntime(): GmailRuntime {
  return loadBundledPluginPublicSurfaceModuleSyncCore<GmailRuntime>({
    dirName: "gmail",
    artifactBasename: "runtime-api.js",
  });
}
