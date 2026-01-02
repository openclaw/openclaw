import { confirm, intro, note, outro } from "@clack/prompts";

import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import type { ClawdisConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDIS,
  readConfigFileSnapshot,
  validateConfigObject,
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

type LegacyMigration = {
  id: string;
  describe: string;
  apply: (raw: Record<string, unknown>, changes: string[]) => void;
};

const LEGACY_MIGRATIONS: LegacyMigration[] = [
  // Legacy migration (2026-01-02, commit: 3c6b59d8) — normalize per-provider allowlists; move WhatsApp gating into whatsapp.allowFrom.
  {
    id: "routing.allowFrom->whatsapp.allowFrom",
    describe: "Move routing.allowFrom to whatsapp.allowFrom",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") return;
      const allowFrom = (routing as Record<string, unknown>).allowFrom;
      if (allowFrom === undefined) return;

      const whatsapp =
        raw.whatsapp && typeof raw.whatsapp === "object"
          ? (raw.whatsapp as Record<string, unknown>)
          : {};

      if (whatsapp.allowFrom === undefined) {
        whatsapp.allowFrom = allowFrom;
        changes.push("Moved routing.allowFrom → whatsapp.allowFrom.");
      } else {
        changes.push("Removed routing.allowFrom (whatsapp.allowFrom already set).");
      }

      delete (routing as Record<string, unknown>).allowFrom;
      if (Object.keys(routing as Record<string, unknown>).length === 0) {
        delete raw.routing;
      }
      raw.whatsapp = whatsapp;
    },
  },
];

function applyLegacyMigrations(raw: unknown): {
  config: ClawdisConfig | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") return { config: null, changes: [] };
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_MIGRATIONS) {
    migration.apply(next, changes);
  }
  if (changes.length === 0) return { config: null, changes: [] };
  const validated = validateConfigObject(next);
  if (!validated.ok) {
    changes.push(
      "Migration applied, but config still invalid; fix remaining issues manually.",
    );
    return { config: null, changes };
  }
  return { config: validated.config, changes };
}

function resolveMode(cfg: ClawdisConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

export async function doctorCommand(runtime: RuntimeEnv = defaultRuntime) {
  printWizardHeader(runtime);
  intro("Clawdis doctor");

  const snapshot = await readConfigFileSnapshot();
  let cfg: ClawdisConfig = snapshot.valid ? snapshot.config : {};
  if (snapshot.exists && !snapshot.valid && snapshot.legacyIssues.length === 0) {
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
      const { config: migrated, changes } = applyLegacyMigrations(
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
    runtime.error(`Health check failed: ${String(err)}`);
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
          runtime.error(`Health check failed: ${String(err)}`);
        }
      }
    }
  }

  cfg = applyWizardMetadata(cfg, { command: "doctor", mode: resolveMode(cfg) });
  await writeConfigFile(cfg);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDIS}`);

  outro("Doctor complete.");
}
