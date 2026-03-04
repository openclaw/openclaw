import path from "node:path";
import type { Command } from "commander";
import { CONFIG_PATH } from "../../config/config.js";
import { createConfigIO } from "../../config/io.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

function resolveModelPrimary(model: AgentModelConfig | undefined): string {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.primary ?? "";
}

function resolveModelFallbacks(model: AgentModelConfig | undefined): string[] {
  if (!model || typeof model !== "object") return [];
  return model.fallbacks ?? [];
}

function resolveChannelsSummary(cfg: OpenClawConfig): string[] {
  const channels = cfg.channels;
  if (!channels) return [];
  const KNOWN_CHANNELS = [
    "whatsapp",
    "telegram",
    "discord",
    "slack",
    "signal",
    "irc",
    "imessage",
    "googlechat",
    "msteams",
  ] as const;
  const active: string[] = [];
  for (const ch of KNOWN_CHANNELS) {
    const channelCfg = channels[ch] as Record<string, unknown> | undefined;
    if (!channelCfg) continue;
    if (channelCfg.enabled === false) continue;
    const dmPolicy =
      typeof channelCfg.dmPolicy === "string" && channelCfg.dmPolicy
        ? channelCfg.dmPolicy
        : undefined;
    active.push(dmPolicy ? `${ch} (${dmPolicy})` : ch);
  }
  return active;
}

export type GatewayValidateResult =
  | {
      valid: true;
      configPath: string;
      model: string;
      fallbacks: string[];
      channels: string[];
      warnings: string[];
    }
  | {
      valid: false;
      configPath: string;
      issues: Array<{ path: string; message: string }>;
    };

/**
 * Validate a gateway config file without touching the running gateway.
 *
 * Performs full Zod schema validation plus env-var substitution and $include
 * resolution — the same pipeline used at gateway startup — but without
 * binding any ports or connecting to any channels.
 */
export async function validateGatewayConfig(
  configPathOverride?: string,
): Promise<GatewayValidateResult> {
  const configPath = configPathOverride
    ? path.resolve(process.cwd(), configPathOverride)
    : CONFIG_PATH;

  const io = createConfigIO({ configPath });
  const snapshot = await io.readConfigFileSnapshot();

  if (!snapshot.exists) {
    return {
      valid: false,
      configPath,
      issues: [{ path: "", message: `Config file not found: ${configPath}` }],
    };
  }

  if (!snapshot.valid) {
    return {
      valid: false,
      configPath,
      issues: snapshot.issues.map((issue) => ({
        path: issue.path ?? "",
        message: issue.message,
      })),
    };
  }

  const cfg = snapshot.config;
  const agentDefaults = cfg.agents?.defaults;
  const model = resolveModelPrimary(agentDefaults?.model);
  const fallbacks = resolveModelFallbacks(agentDefaults?.model);
  const channels = resolveChannelsSummary(cfg);
  const warnings = (snapshot.warnings ?? []).map((w) => w.message);

  return {
    valid: true,
    configPath,
    model,
    fallbacks,
    channels,
    warnings,
  };
}

export function printGatewayValidateResult(result: GatewayValidateResult): void {
  const rich = isRich();

  if (!result.valid) {
    defaultRuntime.log(colorize(rich, theme.error, "✗ Config invalid:"));
    for (const issue of result.issues) {
      const fieldPath = issue.path || "(root)";
      defaultRuntime.log(`  ${colorize(rich, theme.muted, fieldPath)}: ${issue.message}`);
    }
    return;
  }

  defaultRuntime.log(
    colorize(rich, theme.success, "✓ Config valid — gateway would start successfully"),
  );

  if (result.model) {
    defaultRuntime.log(`  ${colorize(rich, theme.muted, "model:")} ${result.model}`);
  }
  if (result.channels.length > 0) {
    defaultRuntime.log(
      `  ${colorize(rich, theme.muted, "channels:")} ${result.channels.join(", ")}`,
    );
  }
  if (result.fallbacks.length > 0) {
    defaultRuntime.log(
      `  ${colorize(rich, theme.muted, "fallbacks:")} ${result.fallbacks.join(", ")}`,
    );
  }
  for (const warning of result.warnings) {
    defaultRuntime.log(`  ${colorize(rich, theme.warn, "warn:")} ${warning}`);
  }
}

export function addGatewayValidateCommand(cmd: Command): Command {
  return cmd
    .command("validate")
    .description(
      "Validate gateway config without restarting the running gateway (shadow validation)",
    )
    .option(
      "--config <path>",
      "Path to config file to validate (default: ~/.openclaw/openclaw.json)",
    )
    .option("--json", "Output result as JSON", false)
    .action(async (opts: { config?: string; json?: boolean }) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const result = await validateGatewayConfig(opts.config);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            if (!result.valid) {
              defaultRuntime.exit(1);
            }
            return;
          }
          printGatewayValidateResult(result);
          if (!result.valid) {
            defaultRuntime.exit(1);
          }
        },
        (err) => {
          defaultRuntime.error(`Config validation failed: ${String(err)}`);
          defaultRuntime.exit(1);
        },
      );
    });
}
