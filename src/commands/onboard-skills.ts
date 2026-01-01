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

function upsertSkillEntry(
  cfg: ClawdisConfig,
  skillKey: string,
  patch: { apiKey?: string },
): ClawdisConfig {
  const entries = { ...(cfg.skills?.entries ?? {}) };
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
        options: installable.map((skill) => ({
          value: skill.name,
          label: `${skill.emoji ?? "🧩"} ${skill.name}`,
          hint: skill.install[0]?.label ?? "install",
        })),
      }),
      runtime,
    );

    for (const name of toInstall as string[]) {
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
      spin.stop(result.ok ? `Installed ${name}` : `Install failed: ${name}`);
      if (!result.ok && result.stderr) {
        runtime.log(result.stderr.trim());
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
