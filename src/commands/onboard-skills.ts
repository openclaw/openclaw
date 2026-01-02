import {
  confirm,
  multiselect,
  note,
  select,
  spinner,
  text,
} from "@clack/prompts";

import { installSkill } from "../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import type { ClawdisConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { guardCancel, resolveNodeManagerOptions } from "./onboard-helpers.js";

function summarizeInstallFailure(message: string): string | undefined {
  const cleaned = message
    .replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "")
    .trim();
  if (!cleaned) return undefined;
  const maxLen = 140;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function formatSkillHint(skill: {
  description?: string;
  install: Array<{ label: string }>;
}): string {
  const desc = skill.description?.trim();
  const installLabel = skill.install[0]?.label?.trim();
  const combined =
    desc && installLabel ? `${desc} — ${installLabel}` : desc || installLabel;
  if (!combined) return "install";
  const maxLen = 90;
  return combined.length > maxLen
    ? `${combined.slice(0, maxLen - 1)}…`
    : combined;
}

function upsertSkillEntry(
  cfg: ClawdisConfig,
  skillKey: string,
  patch: { apiKey?: string },
): ClawdisConfig {
  const entries = { ...cfg.skills?.entries };
  const existing = (entries[skillKey] as { apiKey?: string } | undefined) ?? {};
  entries[skillKey] = { ...existing, ...patch };
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      entries,
    },
  };
}

export async function setupSkills(
  cfg: ClawdisConfig,
  workspaceDir: string,
  runtime: RuntimeEnv,
): Promise<ClawdisConfig> {
  const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  const eligible = report.skills.filter((s) => s.eligible);
  const missing = report.skills.filter(
    (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
  );
  const blocked = report.skills.filter((s) => s.blockedByAllowlist);

  note(
    [
      `Eligible: ${eligible.length}`,
      `Missing requirements: ${missing.length}`,
      `Blocked by allowlist: ${blocked.length}`,
    ].join("\n"),
    "Skills status",
  );

  const shouldConfigure = guardCancel(
    await confirm({
      message: "Configure skills now? (recommended)",
      initialValue: true,
    }),
    runtime,
  );
  if (!shouldConfigure) return cfg;

  const nodeManager = guardCancel(
    await select({
      message: "Preferred node manager for skill installs",
      options: resolveNodeManagerOptions(),
    }),
    runtime,
  ) as "npm" | "pnpm" | "bun";

  let next: ClawdisConfig = {
    ...cfg,
    skills: {
      ...cfg.skills,
      install: {
        ...cfg.skills?.install,
        nodeManager,
      },
    },
  };

  const installable = missing.filter(
    (skill) => skill.install.length > 0 && skill.missing.bins.length > 0,
  );
  if (installable.length > 0) {
    const toInstall = guardCancel(
      await multiselect({
        message: "Install missing skill dependencies",
        options: [
          {
            value: "__skip__",
            label: "Skip for now",
            hint: "Continue without installing dependencies",
          },
          ...installable.map((skill) => ({
            value: skill.name,
            label: `${skill.emoji ?? "🧩"} ${skill.name}`,
            hint: formatSkillHint(skill),
          })),
        ],
      }),
      runtime,
    );

    const selected = (toInstall as string[]).filter(
      (name) => name !== "__skip__",
    );
    for (const name of selected) {
      const target = installable.find((s) => s.name === name);
      if (!target || target.install.length === 0) continue;
      const installId = target.install[0]?.id;
      if (!installId) continue;
      const spin = spinner();
      spin.start(`Installing ${name}…`);
      const result = await installSkill({
        workspaceDir,
        skillName: target.name,
        installId,
        config: next,
      });
      if (result.ok) {
        spin.stop(`Installed ${name}`);
      } else {
        const code = result.code == null ? "" : ` (exit ${result.code})`;
        const detail = summarizeInstallFailure(result.message);
        spin.stop(
          `Install failed: ${name}${code}${detail ? ` — ${detail}` : ""}`,
        );
        if (result.stderr) runtime.log(result.stderr.trim());
        else if (result.stdout) runtime.log(result.stdout.trim());
        runtime.log(
          "Tip: run `clawdis doctor` to review skills + requirements.",
        );
      }
    }
  }

  for (const skill of missing) {
    if (!skill.primaryEnv || skill.missing.env.length === 0) continue;
    const wantsKey = guardCancel(
      await confirm({
        message: `Set ${skill.primaryEnv} for ${skill.name}?`,
        initialValue: false,
      }),
      runtime,
    );
    if (!wantsKey) continue;
    const apiKey = String(
      guardCancel(
        await text({
          message: `Enter ${skill.primaryEnv}`,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
        runtime,
      ),
    );
    next = upsertSkillEntry(next, skill.skillKey, { apiKey: apiKey.trim() });
  }

  return next;
}
