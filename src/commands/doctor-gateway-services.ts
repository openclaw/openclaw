import path from "node:path";

import { note } from "@clack/prompts";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import {
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
} from "../daemon/inspect.js";
import {
  findLegacyGatewayServices,
  uninstallLegacyGatewayServices,
} from "../daemon/legacy.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import { auditGatewayServiceConfig } from "../daemon/service-audit.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";

function detectGatewayRuntime(
  programArguments: string[] | undefined,
): GatewayDaemonRuntime {
  const first = programArguments?.[0];
  if (first) {
    const base = path.basename(first).toLowerCase();
    if (base === "bun" || base === "bun.exe") return "bun";
    if (base === "node" || base === "node.exe") return "node";
  }
  return DEFAULT_GATEWAY_DAEMON_RUNTIME;
}

export async function maybeMigrateLegacyGatewayService(
  cfg: ClawdbotConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const legacyServices = await findLegacyGatewayServices(process.env);
  if (legacyServices.length === 0) return;

  note(
    legacyServices
      .map((svc) => `- ${svc.label} (${svc.platform}, ${svc.detail})`)
      .join("\n"),
    "Legacy Clawdis services detected",
  );

  const migrate = await prompter.confirmSkipInNonInteractive({
    message: "Migrate legacy Clawdis services to Clawdbot now?",
    initialValue: true,
  });
  if (!migrate) return;

  try {
    await uninstallLegacyGatewayServices({
      env: process.env,
      stdout: process.stdout,
    });
  } catch (err) {
    runtime.error(`Legacy service cleanup failed: ${String(err)}`);
    return;
  }

  if (resolveIsNixMode(process.env)) {
    note("Nix mode detected; skip installing services.", "Gateway");
    return;
  }

  if (mode === "remote") {
    note("Gateway mode is remote; skipped local service install.", "Gateway");
    return;
  }

  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  if (loaded) {
    note(`Clawdbot ${service.label} already ${service.loadedText}.`, "Gateway");
    return;
  }

  const install = await prompter.confirmSkipInNonInteractive({
    message: "Install Clawdbot gateway service now?",
    initialValue: true,
  });
  if (!install) return;

  const daemonRuntime = await prompter.select<GatewayDaemonRuntime>(
    {
      message: "Gateway daemon runtime",
      options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
      initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
    },
    DEFAULT_GATEWAY_DAEMON_RUNTIME,
  );
  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const port = resolveGatewayPort(cfg, process.env);
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port,
      dev: devMode,
      runtime: daemonRuntime,
    });
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    CLAWDBOT_GATEWAY_TOKEN:
      cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
    CLAWDBOT_LAUNCHD_LABEL:
      process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
  };
  await service.install({
    env: process.env,
    stdout: process.stdout,
    programArguments,
    workingDirectory,
    environment,
  });
}

export async function maybeRepairGatewayServiceConfig(
  cfg: ClawdbotConfig,
  mode: "local" | "remote",
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  if (resolveIsNixMode(process.env)) {
    note("Nix mode detected; skip service updates.", "Gateway");
    return;
  }

  if (mode === "remote") {
    note("Gateway mode is remote; skipped local service audit.", "Gateway");
    return;
  }

  const service = resolveGatewayService();
  let command: Awaited<ReturnType<typeof service.readCommand>> | null = null;
  try {
    command = await service.readCommand(process.env);
  } catch {
    command = null;
  }
  if (!command) return;

  const audit = await auditGatewayServiceConfig({
    env: process.env,
    command,
  });
  if (audit.issues.length === 0) return;

  note(
    audit.issues
      .map((issue) =>
        issue.detail
          ? `- ${issue.message} (${issue.detail})`
          : `- ${issue.message}`,
      )
      .join("\n"),
    "Gateway service config",
  );

  const aggressiveIssues = audit.issues.filter(
    (issue) => issue.level === "aggressive",
  );
  const needsAggressive = aggressiveIssues.length > 0;

  if (needsAggressive && !prompter.shouldForce) {
    note(
      "Custom or unexpected service edits detected. Rerun with --force to overwrite.",
      "Gateway service config",
    );
  }

  const repair = needsAggressive
    ? await prompter.confirmAggressive({
        message: "Overwrite gateway service config with current defaults now?",
        initialValue: Boolean(prompter.shouldForce),
      })
    : await prompter.confirmRepair({
        message:
          "Update gateway service config to the recommended defaults now?",
        initialValue: true,
      });
  if (!repair) return;

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const port = resolveGatewayPort(cfg, process.env);
  const runtimeChoice = detectGatewayRuntime(command.programArguments);
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port,
      dev: devMode,
      runtime: runtimeChoice,
    });
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    CLAWDBOT_PROFILE: process.env.CLAWDBOT_PROFILE,
    CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR,
    CLAWDBOT_CONFIG_PATH: process.env.CLAWDBOT_CONFIG_PATH,
    CLAWDBOT_GATEWAY_PORT: String(port),
    CLAWDBOT_GATEWAY_TOKEN:
      cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
    CLAWDBOT_LAUNCHD_LABEL:
      process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
  };

  try {
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    runtime.error(`Gateway service update failed: ${String(err)}`);
  }
}

export async function maybeScanExtraGatewayServices(options: DoctorOptions) {
  const extraServices = await findExtraGatewayServices(process.env, {
    deep: options.deep,
  });
  if (extraServices.length === 0) return;

  note(
    extraServices
      .map((svc) => `- ${svc.label} (${svc.scope}, ${svc.detail})`)
      .join("\n"),
    "Other gateway-like services detected",
  );

  const cleanupHints = renderGatewayServiceCleanupHints();
  if (cleanupHints.length > 0) {
    note(cleanupHints.map((hint) => `- ${hint}`).join("\n"), "Cleanup hints");
  }

  note(
    [
      "Recommendation: run a single gateway per machine.",
      "One gateway supports multiple agents.",
      "If you need multiple gateways, isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
    ].join("\n"),
    "Gateway recommendation",
  );
}
