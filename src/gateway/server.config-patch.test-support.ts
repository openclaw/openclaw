import fs from "node:fs/promises";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";

export async function withConfigFileFixture(configPath: string, run: () => Promise<void>) {
  const originalRaw = await fs.readFile(configPath, "utf-8");
  try {
    await run();
  } finally {
    await fs.writeFile(configPath, originalRaw, "utf-8");
    invalidateConfigGetResponseCache();
  }
}

export function configRawPayload(config: unknown, baseHash?: string) {
  return {
    raw: JSON.stringify(config, null, 2),
    baseHash,
  };
}

export function makeApprovedOperationAuditConfig(
  config: Record<string, unknown>,
  layout: "unrelated-include" | "include-only",
) {
  const agents = {
    entries: { main: {} },
    defaults: { model: { primary: "openai/gpt-4.1" } },
  };
  return {
    includedConfig: layout === "include-only" ? agents : { level: "info" },
    root: {
      ...config,
      // This proof owns persistence/journals, not unrelated model/plugin activation.
      gateway: { reload: { mode: "off" } },
      agents: layout === "include-only" ? { $include: "./audit-include.json" } : agents,
      ...(layout === "unrelated-include" ? { logging: { $include: "./audit-include.json" } } : {}),
    },
  };
}

export function configWithGatewayTokenSecretRef(config: Record<string, unknown>, envVar: string) {
  const nextConfig = structuredClone(config);
  const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
  gateway.auth = {
    mode: "token",
    token: { source: "env", provider: "default", id: envVar },
  };
  return nextConfig;
}

export function makeRouteBinding(index: number) {
  return {
    agentId: "main",
    match: {
      channel: "telegram",
      peer: {
        kind: "direct",
        id: `user-${index}`,
      },
    },
  };
}
