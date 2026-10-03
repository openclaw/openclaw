import fs from "node:fs/promises";
import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import type {
  ConfigFileSnapshot,
  GatewayControlUiConfig,
  OpenClawConfig,
} from "../../config/types.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";

export type ConfigSummary = {
  path: string;
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  warnings?: ConfigFileSnapshot["warnings"];
  controlUi?: GatewayControlUiConfig;
};

type StatusConfigRead = {
  summary: ConfigSummary;
  cfg: OpenClawConfig;
  mode: "fast" | "full";
};

const loadConfigIoRuntime = createLazyPromise(() => import("../../config/io.runtime.js"));

async function readFastStatusConfig(configPath: string): Promise<StatusConfigRead | null> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    return {
      summary: { path: configPath, exists: false, valid: true },
      cfg: {},
      mode: "fast",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (err) {
    return {
      summary: {
        path: configPath,
        exists: true,
        valid: false,
        issues: [{ path: "", message: `JSON5 parse failed: ${String(err)}` }],
      },
      cfg: {},
      mode: "fast",
    };
  }

  const cfg: OpenClawConfig = asNonArrayRecord(parsed);
  // Includes and environment expansion require the full config owner.
  if (raw.includes("$include") || raw.includes("${") || Object.hasOwn(cfg, "env")) {
    return null;
  }

  return {
    summary: {
      path: configPath,
      exists: true,
      valid: true,
      controlUi: cfg.gateway?.controlUi,
    },
    cfg,
    mode: "fast",
  };
}

// Rejected non-object values fall back to defaults so status can still render its summary.
function dropRejectedConfigValues(
  cfg: OpenClawConfig,
  issues: ReadonlyArray<{ path: string }>,
): OpenClawConfig {
  if (issues.length === 0) {
    return cfg;
  }
  const next = structuredClone(cfg);
  for (const issue of issues) {
    const keys = issue.path.split(".").filter(Boolean);
    const leaf = keys.pop();
    let parent: unknown = next;
    for (const key of keys) {
      parent = isRecord(parent) ? parent[key] : undefined;
    }
    if (leaf && isRecord(parent) && !isRecord(parent[leaf])) {
      delete parent[leaf];
    }
  }
  return next;
}

async function readFullStatusConfig(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
  pluginValidation?: "full" | "skip";
}): Promise<StatusConfigRead> {
  const { createConfigIO } = await loadConfigIoRuntime();
  const io = createConfigIO({
    env: params.env,
    configPath: params.configPath,
    observe: false,
    pluginValidation: params.pluginValidation ?? "skip",
    logger: {
      error: () => {},
      warn: () => {},
    },
  });
  const snapshot = await io.readConfigFileSnapshot().catch(() => null);
  // Invalid snapshots stay inspectable; status reports their issues instead of failing.
  const cfg = snapshot
    ? dropRejectedConfigValues(snapshot.runtimeConfig, snapshot.valid ? [] : snapshot.issues)
    : io.loadConfig();
  return {
    summary: {
      path: snapshot?.path ?? params.configPath,
      exists: snapshot?.exists ?? false,
      valid: snapshot?.valid ?? true,
      ...(snapshot?.issues?.length ? { issues: snapshot.issues } : {}),
      ...(snapshot?.warnings?.length ? { warnings: snapshot.warnings } : {}),
      controlUi: cfg.gateway?.controlUi,
    },
    cfg,
    mode: "full",
  };
}

export async function readStatusConfig(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
  deep?: boolean;
}): Promise<StatusConfigRead> {
  return (
    (params.deep ? null : await readFastStatusConfig(params.configPath)) ??
    (await readFullStatusConfig({
      env: params.env,
      configPath: params.configPath,
      pluginValidation: params.deep ? "full" : "skip",
    }))
  );
}
