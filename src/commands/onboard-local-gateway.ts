import type { OpenClawConfig } from "../config/config.js";
import {
  normalizeSecretInputString,
  resolveSecretInputRef,
  type SecretInput,
} from "../config/types.secrets.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";
import type { LocalSetupExecutionPlan } from "./onboard-local-plan.js";
import type { GatewayAuthChoice, GatewayBind, TailscaleMode } from "./onboard-types.js";

export const INSTALL_DAEMON_HEALTH_DEADLINE_MS = 45_000;
export const ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS = 15_000;

export type LocalGatewaySetupState = {
  mode: "local";
  port: number;
  bind: GatewayBind;
  customBindHost?: string;
  authMode: GatewayAuthChoice;
  gatewayToken?: string;
  gatewayPassword?: SecretInput;
  tailscaleMode: TailscaleMode;
  tailscaleResetOnExit: boolean;
};

export type LocalGatewaySetupResult = {
  nextConfig: OpenClawConfig;
  state: LocalGatewaySetupState;
};

export type LocalGatewayReachabilityPlan = {
  healthExpectation: LocalSetupExecutionPlan["healthExpectation"];
  shouldRunHealthCheck: boolean;
  deadlineMs: number;
  wsUrl: string;
  httpUrl: string;
  token?: string;
  password?: string;
};

export function resolveLocalGatewayLinks(params: {
  state: LocalGatewaySetupState;
  basePath?: string;
}) {
  return resolveControlUiLinks({
    bind: params.state.bind,
    port: params.state.port,
    customBindHost: params.state.customBindHost,
    basePath: params.basePath,
  });
}

export async function resolveLocalGatewayReachabilityAuth(params: {
  state: LocalGatewaySetupState;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  if (params.state.authMode === "token") {
    return {
      token: params.state.gatewayToken,
    };
  }

  // Password auth can be plaintext or SecretRef-backed. Resolve it once here so
  // callers do not hand-roll the same config/env lookup logic in multiple flows.
  const { ref } = resolveSecretInputRef({
    value: params.state.gatewayPassword,
    defaults: params.config.secrets?.defaults,
  });
  if (ref) {
    return {
      password: await resolveSecretRefString(ref, {
        config: params.config,
        env: params.env ?? process.env,
      }),
    };
  }

  return {
    password: normalizeSecretInputString(params.state.gatewayPassword) ?? "",
  };
}

export async function resolveLocalGatewayReachabilityPlan(params: {
  state: LocalGatewaySetupState;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  executionPlan: Pick<LocalSetupExecutionPlan, "healthExpectation" | "shouldRunHealthCheck">;
  basePath?: string;
}): Promise<LocalGatewayReachabilityPlan> {
  const links = resolveLocalGatewayLinks({
    state: params.state,
    basePath: params.basePath,
  });
  const auth = await resolveLocalGatewayReachabilityAuth({
    state: params.state,
    config: params.config,
    env: params.env,
  });

  return {
    healthExpectation: params.executionPlan.healthExpectation,
    shouldRunHealthCheck: params.executionPlan.shouldRunHealthCheck,
    deadlineMs:
      params.executionPlan.healthExpectation === "managed-gateway"
        ? INSTALL_DAEMON_HEALTH_DEADLINE_MS
        : ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS,
    wsUrl: links.wsUrl,
    httpUrl: links.httpUrl,
    token: auth.token,
    password: auth.password,
  };
}
