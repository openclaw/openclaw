import { confirm, intro, note, outro } from "@clack/prompts";

import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import type { ClawdisConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDIS,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
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

function resolveMode(cfg: ClawdisConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

export async function doctorCommand(runtime: RuntimeEnv = defaultRuntime) {
  printWizardHeader(runtime);
  intro("Clawdis doctor");

  const snapshot = await readConfigFileSnapshot();
  let cfg: ClawdisConfig = snapshot.valid ? snapshot.config : {};
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
  runtime.log(`Updated ${CONFIG_PATH_CLAWDIS}`);

  outro("Doctor complete.");
}
