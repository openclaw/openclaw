// Config reads and diagnostic projection for Gateway service status.
import fs from "node:fs/promises";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import type {
  OpenClawConfig,
  ConfigFileSnapshot,
  GatewayControlUiConfig,
} from "../../config/types.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { safeParseWithSchema } from "../../utils/zod-parse.js";

type ConfigSummary = {
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

async function resolveInvalidStatusConfig(value: unknown): Promise<OpenClawConfig> {
  const [{ GatewayConfigSchema }, { SecretsConfigSchema }, { LoggingConfigSchema }] =
    await Promise.all([
      import("../../config/zod-schema.gateway.js"),
      import("../../config/zod-schema.core.js"),
      import("../../config/zod-schema.logging.js"),
    ]);
  const raw = asNonArrayRecord(value);
  // Diagnostic consumers need valid connection fields, not unrelated runtime policy.
  const gateway = asNonArrayRecord(raw.gateway);
  const fields = GatewayConfigSchema.unwrap().shape;
  const secrets = SecretsConfigSchema.safeParse(raw.secrets);
  const logging = LoggingConfigSchema.safeParse(raw.logging);
  return {
    gateway: {
      mode: safeParseWithSchema(fields.mode, gateway.mode) ?? undefined,
      port: safeParseWithSchema(fields.port, gateway.port) ?? undefined,
      bind: safeParseWithSchema(fields.bind, gateway.bind) ?? undefined,
      customBindHost:
        safeParseWithSchema(fields.customBindHost, gateway.customBindHost) ?? undefined,
      auth: safeParseWithSchema(fields.auth, gateway.auth) ?? undefined,
      remote: safeParseWithSchema(fields.remote, gateway.remote) ?? undefined,
      tls: safeParseWithSchema(fields.tls, gateway.tls) ?? undefined,
      controlUi: safeParseWithSchema(fields.controlUi, gateway.controlUi) ?? undefined,
    },
    ...(secrets.success ? { secrets: secrets.data } : {}),
    ...(logging.success ? { logging: logging.data } : {}),
  };
}

async function readFastStatusConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<StatusConfigRead | null> {
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

  // Includes and environment expansion require the full config owner.
  if (
    raw.includes("$include") ||
    raw.includes("${") ||
    Object.hasOwn(asNonArrayRecord(parsed), "env")
  ) {
    return null;
  }
  const { validateConfigObjectRaw } = await import("../../config/validation-core.js");
  const validated = validateConfigObjectRaw(parsed, { env });
  const cfg = validated.ok ? validated.config : await resolveInvalidStatusConfig(parsed);

  return {
    summary: {
      path: configPath,
      exists: true,
      valid: validated.ok,
      ...(!validated.ok ? { issues: validated.issues } : {}),
      controlUi: cfg.gateway?.controlUi,
    },
    cfg,
    mode: "fast",
  };
}

export async function readDaemonStatusConfig(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
  deep?: boolean;
}): Promise<StatusConfigRead> {
  if (!params.deep) {
    const fast = await readFastStatusConfig(params.configPath, params.env);
    if (fast) {
      return fast;
    }
  }
  const { createConfigIO } = await import("../../config/io.runtime.js");
  const io = createConfigIO({
    env: params.env,
    configPath: params.configPath,
    observe: false,
    pluginValidation: params.deep ? "full" : "skip",
    logger: {
      error: () => {},
      warn: () => {},
    },
  });
  const snapshot = await io.readConfigFileSnapshot().catch(() => null);
  const cfg = snapshot?.valid
    ? (snapshot.runtimeConfig ?? snapshot.config)
    : await resolveInvalidStatusConfig(snapshot?.config);
  return {
    summary: {
      path: snapshot?.path ?? params.configPath,
      exists: snapshot?.exists ?? false,
      valid: snapshot?.valid ?? false,
      ...(!snapshot ? { issues: [{ path: "", message: "Configuration could not be read." }] } : {}),
      ...(snapshot?.issues?.length ? { issues: snapshot.issues } : {}),
      ...(snapshot?.warnings?.length ? { warnings: snapshot.warnings } : {}),
      controlUi: cfg.gateway?.controlUi,
    },
    cfg,
    mode: "full",
  };
}
