import type { OpenClawConfig } from "../../config/config.js";
import {
  isGatewaySecretRefUnavailableError,
  resolveGatewayDriftCheckCredentialsFromConfig,
} from "../../gateway/credentials.js";

export function resolveGatewayTokenForDriftCheck(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  void params.env;
  try {
    return resolveGatewayDriftCheckCredentialsFromConfig({ cfg: params.cfg }).token;
  } catch (error) {
    if (isGatewaySecretRefUnavailableError(error, "gateway.auth.token")) {
      return undefined;
    }
    throw error;
  }
}
