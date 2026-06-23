import type { PluginActionCapability } from "./plugin-capability-policy";
import type { PluginLogger } from "./types.js";

export type PluginManifest = {
  name: string;
  description?: string;
  capabilities: readonly string[];
  entrypoint: string;
  enabledByDefault?: boolean;
  riskLevel?: "low" | "medium" | "high";
};

export type PluginAdapterContext = {
  coreApi: PluginCoreApi;
  logger: PluginLogger;
  requestApproval: PluginApprovalRequester;
};

export type PluginAdapter = {
  manifest: PluginManifest;
  initialize?: (context: PluginAdapterContext) => Promise<void> | void;
  healthCheck?: () => Promise<PluginHealth> | PluginHealth;
};

export type PluginActionDescriptor = {
  id: string;
  name: string;
  description?: string;
  capabilities: readonly PluginActionCapability[];
};

export type PluginCoreApi = {
  readMemory?: (query: string) => Promise<unknown>;
  writeMemory?: (input: unknown) => Promise<unknown>;
  emitEvent?: (event: unknown) => Promise<void>;
};

export type PluginHealth = {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
};

export type PluginApprovalRequest = {
  pluginName: string;
  action: string;
  riskLevel: "low" | "medium" | "high";
  summary: string;
  payload?: unknown;
};

export type PluginApprovalResult = {
  approved: boolean;
  reason?: string;
};

export type PluginApprovalRequester = (
  request: PluginApprovalRequest,
) => Promise<PluginApprovalResult>;
