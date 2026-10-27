import type { AgentHarnessRuntimeAvailability } from "../../agents/harness/runtime-plugin.js";

export type ModelRow = {
  key: string;
  name: string;
  input: string;
  contextWindow: number | null;
  contextTokens?: number;
  local: boolean | null;
  available: boolean | null;
  tags: string[];
};

export type ProviderAuthOverview = {
  provider: string;
  effective: {
    kind: "profiles" | "env" | "models.json" | "synthetic" | "runtime" | "missing";
    detail: string;
  };
  profiles: {
    count: number;
    oauth: number;
    token: number;
    apiKey: number;
    labels: string[];
  };
  env?: { value: string; source: string };
  modelsJson?: { value: string; source: string };
  syntheticAuth?: { value: string; source: string };
};

type StatusRuntimeAuthStatus = "usable" | "missing" | "indeterminate";

type StatusRuntimeAuthRouteBase = {
  provider: string;
  runtime: string;
  authProvider: string;
  effective: ProviderAuthOverview["effective"];
};

export type StatusRuntimeAuthRoute =
  | (StatusRuntimeAuthRouteBase & {
      status: StatusRuntimeAuthStatus;
    })
  | (StatusRuntimeAuthRouteBase & {
      status: "unavailable";
      authStatus: StatusRuntimeAuthStatus;
      runtimeStatus: "unavailable";
      runtimeReason: Extract<AgentHarnessRuntimeAvailability, { status: "unavailable" }>["reason"];
      runtimeDetail: string;
      runtimePluginIds: string[];
    });
