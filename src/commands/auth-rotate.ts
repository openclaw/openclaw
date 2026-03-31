import {
  readConfigFileSnapshot,
  replaceConfigFile,
  type OpenClawConfig,
} from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { setGatewayTokenIssuedAtNow } from "../gateway/token-expiry-state.js";
import type { RuntimeEnv } from "../runtime.js";
import { randomToken } from "./onboard-helpers.js";

export async function runGatewayAuthRotateCommand(runtime: RuntimeEnv): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists) {
    runtime.error("No config file found; cannot rotate gateway token.");
    runtime.exit(1);
    return;
  }
  if (!snapshot.valid) {
    runtime.error("Config file is invalid; fix config before rotating gateway token.");
    runtime.exit(1);
    return;
  }
  const baseConfig = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const tokenRef = resolveSecretInputRef({
    value: baseConfig.gateway?.auth?.token,
    defaults: baseConfig.secrets?.defaults,
  }).ref;
  if (tokenRef) {
    runtime.error(
      "Cannot rotate token: gateway.auth.token is managed via SecretRef (or an env-template like ${VAR}). Update the secret at its source instead. This command does not overwrite, resolve, or modify SecretRef-backed values.",
    );
    runtime.exit(1);
    return;
  }

  const nextToken = randomToken();
  const nextConfig: OpenClawConfig = {
    ...baseConfig,
    gateway: {
      ...baseConfig.gateway,
      auth: {
        ...baseConfig.gateway?.auth,
        mode: "token",
        token: nextToken,
      },
    },
  };

  await replaceConfigFile({
    nextConfig,
    baseHash: snapshot.hash,
  });
  setGatewayTokenIssuedAtNow();
  runtime.log("Gateway auth token rotated; new token written to gateway.auth.token.");
  process.stdout.write(`${nextToken}\n`);
}
