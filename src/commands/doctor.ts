import os from "node:os";
import path from "node:path";

import { confirm, intro, note, outro } from "@clack/prompts";

import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  createConfigIO,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import {
  findLegacyGatewayServices,
  uninstallLegacyGatewayServices,
} from "../daemon/legacy.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, sleep } from "../utils.js";
import { healthCommand } from "./health.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  guardCancel,
  printWizardHeader,
} from "./onboard-helpers.js";

function resolveMode(cfg: ClawdbotConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

function resolveLegacyConfigPath(env: NodeJS.ProcessEnv): string {
  const override = env.CLAWDIS_CONFIG_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".clawdis", "clawdis.json");
}

function replacePathSegment(
  value: string | undefined,
  from: string,
  to: string,
): string | undefined {
  if (!value) return value;
  const pattern = new RegExp(`(^|[\\/])${from}([\\/]|$)`, "g");
  if (!pattern.test(value)) return value;
  return value.replace(pattern, `$1${to}$2`);
}

function replaceLegacyName(value: string | undefined): string | undefined {
  if (!value) return value;
  const replacedClawdis = value.replace(/clawdis/g, "clawdbot");
  return replacedClawdis.replace(/clawd(?!bot)/g, "clawdbot");
}

function normalizeLegacyConfigValues(cfg: ClawdbotConfig): {
  config: ClawdbotConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next: ClawdbotConfig = cfg;

  const workspace = cfg.agent?.workspace;
  const updatedWorkspace = replacePathSegment(
    replacePathSegment(workspace, "clawdis", "clawdbot"),
    "clawd",
    "clawdbot",
  );
  if (updatedWorkspace && updatedWorkspace !== workspace) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        workspace: updatedWorkspace,
      },
    };
    changes.push(`Updated agent.workspace → ${updatedWorkspace}`);
  }

  const workspaceRoot = cfg.agent?.sandbox?.workspaceRoot;
  const updatedWorkspaceRoot = replacePathSegment(
    replacePathSegment(workspaceRoot, "clawdis", "clawdbot"),
    "clawd",
    "clawdbot",
  );
  if (updatedWorkspaceRoot && updatedWorkspaceRoot !== workspaceRoot) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          workspaceRoot: updatedWorkspaceRoot,
        },
      },
    };
    changes.push(
      `Updated agent.sandbox.workspaceRoot → ${updatedWorkspaceRoot}`,
    );
  }

  const dockerImage = cfg.agent?.sandbox?.docker?.image;
  const updatedDockerImage = replaceLegacyName(dockerImage);
  if (updatedDockerImage && updatedDockerImage !== dockerImage) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          docker: {
            ...next.agent?.sandbox?.docker,
            image: updatedDockerImage,
          },
        },
      },
    };
    changes.push(`Updated agent.sandbox.docker.image → ${updatedDockerImage}`);
  }

  const containerPrefix = cfg.agent?.sandbox?.docker?.containerPrefix;
  const updatedContainerPrefix = replaceLegacyName(containerPrefix);
  if (updatedContainerPrefix && updatedContainerPrefix !== containerPrefix) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          docker: {
            ...next.agent?.sandbox?.docker,
            containerPrefix: updatedContainerPrefix,
          },
        },
      },
    };
    changes.push(
      `Updated agent.sandbox.docker.containerPrefix → ${updatedContainerPrefix}`,
    );
  }

  return { config: next, changes };
}

async function maybeMigrateLegacyConfigFile(runtime: RuntimeEnv) {
  const legacyConfigPath = resolveLegacyConfigPath(process.env);
  if (legacyConfigPath === CONFIG_PATH_CLAWDBOT) return;

  const legacyIo = createConfigIO({ configPath: legacyConfigPath });
  const legacySnapshot = await legacyIo.readConfigFileSnapshot();
  if (!legacySnapshot.exists) return;

  const currentSnapshot = await readConfigFileSnapshot();
  if (currentSnapshot.exists) {
    note(
      `Legacy config still exists at ${legacyConfigPath}. Current config at ${CONFIG_PATH_CLAWDBOT}.`,
      "Legacy config",
    );
    return;
  }

  const gatewayMode =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.gateway?.mode === "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).gateway?.mode
      : undefined;
  const gatewayBind =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.gateway?.bind === "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).gateway?.bind
      : undefined;
  const agentWorkspace =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.agent?.workspace ===
    "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).agent?.workspace
      : undefined;

  note(
    [
      `- File exists at ${legacyConfigPath}`,
      gatewayMode ? `- gateway.mode: ${gatewayMode}` : undefined,
      gatewayBind ? `- gateway.bind: ${gatewayBind}` : undefined,
      agentWorkspace ? `- agent.workspace: ${agentWorkspace}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    "Legacy Clawdis config detected",
  );

  let nextConfig = legacySnapshot.valid ? legacySnapshot.config : null;
  const { config: migratedConfig, changes } = migrateLegacyConfig(
    legacySnapshot.parsed,
  );
  if (migratedConfig) {
    nextConfig = migratedConfig;
  } else if (!nextConfig) {
    note(
      `Legacy config at ${legacyConfigPath} is invalid; skipping migration.`,
      "Legacy config",
    );
    return;
  }

  const normalized = normalizeLegacyConfigValues(nextConfig);
  const mergedChanges = [...changes, ...normalized.changes];
  if (mergedChanges.length > 0) {
    note(mergedChanges.join("\n"), "Doctor changes");
  }

  await writeConfigFile(normalized.config);
  runtime.log(`Migrated legacy config to ${CONFIG_PATH_CLAWDBOT}`);
}

async function maybeMigrateLegacyGatewayService(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
) {
  const legacyServices = await findLegacyGatewayServices(process.env);
  if (legacyServices.length === 0) return;

  note(
    legacyServices
      .map((svc) => `- ${svc.label} (${svc.platform}, ${svc.detail})`)
      .join("\n"),
    "Legacy Clawdis services detected",
  );

  const migrate = guardCancel(
    await confirm({
      message: "Migrate legacy Clawdis services to Clawdbot now?",
      initialValue: true,
    }),
    runtime,
  );
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

  if (resolveMode(cfg) === "remote") {
    note("Gateway mode is remote; skipped local service install.", "Gateway");
    return;
  }

  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  if (loaded) {
    note(`Clawdbot ${service.label} already ${service.loadedText}.`, "Gateway");
    return;
  }

  const install = guardCancel(
    await confirm({
      message: "Install Clawdbot gateway service now?",
      initialValue: true,
    }),
    runtime,
  );
  if (!install) return;

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const port = resolveGatewayPort(cfg, process.env);
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({ port, dev: devMode });
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

export async function doctorCommand(runtime: RuntimeEnv = defaultRuntime) {
  printWizardHeader(runtime);
  intro("Clawdbot doctor");

  await maybeMigrateLegacyConfigFile(runtime);

  const snapshot = await readConfigFileSnapshot();
  let cfg: ClawdbotConfig = snapshot.valid ? snapshot.config : {};
  if (
    snapshot.exists &&
    !snapshot.valid &&
    snapshot.legacyIssues.length === 0
  ) {
    note("Config invalid; doctor will run with defaults.", "Config");
  }

  if (snapshot.legacyIssues.length > 0) {
    note(
      snapshot.legacyIssues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n"),
      "Legacy config keys detected",
    );
    const migrate = guardCancel(
      await confirm({
        message: "Migrate legacy config entries now?",
        initialValue: true,
      }),
      runtime,
    );
    if (migrate) {
      // Legacy migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into whatsapp.allowFrom.
      const { config: migrated, changes } = migrateLegacyConfig(
        snapshot.parsed,
      );
      if (changes.length > 0) {
        note(changes.join("\n"), "Doctor changes");
      }
      if (migrated) {
        cfg = migrated;
      }
    }
  }

  const normalized = normalizeLegacyConfigValues(cfg);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    cfg = normalized.config;
  }

  await maybeMigrateLegacyGatewayService(cfg, runtime);

  const workspaceDir = resolveUserPath(
    cfg.agent?.workspace ?? DEFAULT_WORKSPACE,
  );
  const skillsReport = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  note(
    [
      `Eligible: ${skillsReport.skills.filter((s) => s.eligible).length}`,
      `Missing requirements: ${
        skillsReport.skills.filter(
          (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
        ).length
      }`,
      `Blocked by allowlist: ${
        skillsReport.skills.filter((s) => s.blockedByAllowlist).length
      }`,
    ].join("\n"),
    "Skills status",
  );

  let healthOk = false;
  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    healthOk = true;
  } catch (err) {
    const message = String(err);
    if (message.includes("gateway closed")) {
      note("Gateway not running.", "Gateway");
    } else {
      runtime.error(`Health check failed: ${message}`);
    }
  }

  if (!healthOk) {
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (!loaded) {
      note("Gateway daemon not installed.", "Gateway");
    } else {
      const restart = guardCancel(
        await confirm({
          message: "Restart gateway daemon now?",
          initialValue: true,
        }),
        runtime,
      );
      if (restart) {
        await service.restart({ stdout: process.stdout });
        await sleep(1500);
        try {
          await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
        } catch (err) {
          const message = String(err);
          if (message.includes("gateway closed")) {
            note("Gateway not running.", "Gateway");
          } else {
            runtime.error(`Health check failed: ${message}`);
          }
        }
      }
    }
  }

  cfg = applyWizardMetadata(cfg, { command: "doctor", mode: resolveMode(cfg) });
  await writeConfigFile(cfg);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

  outro("Doctor complete.");
}
