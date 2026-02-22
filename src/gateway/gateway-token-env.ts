import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";

export const GATEWAY_TOKEN_ENV_VAR = "OPENCLAW_GATEWAY_TOKEN";
export const GATEWAY_TOKEN_ENV_REF = `\${${GATEWAY_TOKEN_ENV_VAR}}`;

const GATEWAY_TOKEN_LINE_RE =
  /^\s*(?:export\s+)?(?:OPENCLAW_GATEWAY_TOKEN|CLAWDBOT_GATEWAY_TOKEN)\s*=/;

function formatDotEnvValue(value: string): string {
  const safeBare = /^[A-Za-z0-9._:/@-]+$/;
  if (safeBare.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isGatewayTokenEnvReference(value: string | undefined): boolean {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return false;
  }
  return trimmed === GATEWAY_TOKEN_ENV_REF;
}

export function resolveGatewayTokenForStorage(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configToken = trimToUndefined(cfg.gateway?.auth?.token);
  if (configToken && !isGatewayTokenEnvReference(configToken)) {
    return configToken;
  }
  return trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN) ?? trimToUndefined(env.CLAWDBOT_GATEWAY_TOKEN);
}

export function withGatewayTokenEnvReference(
  cfg: OpenClawConfig,
  token: string | undefined,
): OpenClawConfig {
  const trimmedToken = trimToUndefined(token);
  if (cfg.gateway?.auth?.mode !== "token" || !trimmedToken) {
    return cfg;
  }
  if (isGatewayTokenEnvReference(cfg.gateway?.auth?.token)) {
    return cfg;
  }
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      auth: {
        ...cfg.gateway?.auth,
        mode: "token",
        token: GATEWAY_TOKEN_ENV_REF,
      },
    },
  };
}

export async function upsertGatewayTokenDotEnv(opts: {
  token: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<{ dotenvPath: string; changed: boolean }> {
  const env = opts.env ?? process.env;
  const token = opts.token.trim();
  const stateDir = opts.stateDir ?? resolveStateDir(env);
  const dotenvPath = path.join(stateDir, ".env");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(() => {});

  const currentRaw = await fs.readFile(dotenvPath, "utf-8").catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") {
      return "";
    }
    throw err;
  });
  const normalizedCurrent = currentRaw.replace(/\r\n/g, "\n");
  const currentLines = normalizedCurrent.length > 0 ? normalizedCurrent.split("\n") : [];
  const assignment = `${GATEWAY_TOKEN_ENV_VAR}=${formatDotEnvValue(token)}`;
  const nextLines: string[] = [];
  let replaced = false;
  for (const line of currentLines) {
    if (GATEWAY_TOKEN_LINE_RE.test(line)) {
      if (!replaced) {
        nextLines.push(assignment);
        replaced = true;
      }
      continue;
    }
    if (line.length === 0 && nextLines.length === 0) {
      continue;
    }
    nextLines.push(line);
  }
  if (!replaced) {
    nextLines.push(assignment);
  }
  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
    nextLines.pop();
  }
  const nextRaw = `${nextLines.join("\n")}\n`;
  const changed = nextRaw !== normalizedCurrent;
  if (changed) {
    await fs.writeFile(dotenvPath, nextRaw, { mode: 0o600, encoding: "utf-8" });
  }
  await fs.chmod(dotenvPath, 0o600).catch(() => {});

  env[GATEWAY_TOKEN_ENV_VAR] = token;
  return { dotenvPath, changed };
}
