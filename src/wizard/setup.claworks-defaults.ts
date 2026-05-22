import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isClaworksCliProduct } from "../cli/cli-name.js";
import {
  CLAWORKS_STANDARD_GATEWAY_PORT,
  coerceClaworksGatewayPort,
} from "../config/claworks-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function loadExtendedPluginAllow(): string[] {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const allowPath = path.join(root, "contrib/claworks-product.plugins.allow.json");
  try {
    const raw = JSON.parse(fs.readFileSync(allowPath, "utf8")) as {
      core?: string[];
      optional_domestic_llm?: string[];
    };
    return [
      ...new Set([...(raw.core ?? ["claworks-robot"]), ...(raw.optional_domestic_llm ?? [])]),
    ];
  } catch {
    return ["claworks-robot", "feishu", "openai", "memory-core", "webhooks"];
  }
}

/** Merge ClaWorks enterprise defaults after onboard/init without wiping user choices. */
export function mergeClaworksProductDefaults(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!isClaworksCliProduct(env)) {
    return config;
  }

  const next: OpenClawConfig = structuredClone(config);
  const allow = loadExtendedPluginAllow();
  const existingAllow = next.plugins?.allow ?? [];
  next.plugins = {
    ...next.plugins,
    allow: [...new Set([...existingAllow, ...allow])],
    entries: { ...next.plugins?.entries },
  };

  next.plugins.entries ??= {};
  next.plugins.entries["claworks-robot"] = {
    enabled: true,
    ...next.plugins.entries["claworks-robot"],
  };
  if (next.plugins.allow?.includes("feishu")) {
    next.plugins.entries.feishu = {
      enabled: true,
      ...next.plugins.entries.feishu,
    };
  }

  next.gateway = {
    mode: "local",
    bind: "loopback",
    ...next.gateway,
  };
  next.gateway.port = coerceClaworksGatewayPort(
    typeof next.gateway.port === "number" ? next.gateway.port : CLAWORKS_STANDARD_GATEWAY_PORT,
    env,
  );

  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    const workspace = next.agents?.defaults?.workspace;
    if (!workspace || workspace.includes(".openclaw")) {
      next.agents = {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          workspace: path.join(stateDir, "workspace"),
        },
      };
    }
  }

  const robotConfig = next.plugins.entries["claworks-robot"]?.config as
    | Record<string, unknown>
    | undefined;
  if (robotConfig && typeof robotConfig === "object") {
    const notify = (robotConfig.notify as Record<string, unknown> | undefined) ?? {};
    robotConfig.notify = {
      default_channel: "feishu",
      ...notify,
    };
  }

  return next;
}
