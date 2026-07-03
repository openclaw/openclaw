/**
 * Interactive skill dependency setup for onboarding.
 *
 * It reports workspace skill readiness, offers safe dependency installs, and
 * leaves per-skill credentials to the agent when a skill actually needs them.
 */
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBrewExecutable } from "../infra/brew.js";
import { isContainerEnvironment } from "../infra/container-environment.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import { installSkill } from "../skills/lifecycle/install.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary } from "./onboard-helpers.js";
import type { NodeManagerChoice } from "./onboard-types.js";

const HOMEBREW_PROMPT_PLATFORMS = new Set(["darwin", "linux"]);
const MIN_AUTO_GO_MAJOR = 1;
const MIN_AUTO_GO_MINOR = 21;
const SKIPPED_INSTALL_NAME_LIMIT = 8;

type OnboardInstallSkill = {
  name: string;
  description?: string;
  install: Array<{ kind: string; label: string }>;
};

type GoToolchainStatus = "missing" | "too-old" | "usable";
type SkippedInstallReason = "brew" | "go" | "uv";
type InstallerReadiness = { ready: true } | { ready: false; reason: SkippedInstallReason };

function supportsHomebrewPrompt(platform: NodeJS.Platform): boolean {
  return HOMEBREW_PROMPT_PLATFORMS.has(platform);
}

function parseGoVersion(output: string): { major: number; minor: number } | undefined {
  const match = /\bgo(\d+)\.(\d+)(?:[.\w-]*)?\b/.exec(output);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function isGoVersionUsableForAutoInstall(version: { major: number; minor: number }): boolean {
  return (
    version.major > MIN_AUTO_GO_MAJOR ||
    (version.major === MIN_AUTO_GO_MAJOR && version.minor >= MIN_AUTO_GO_MINOR)
  );
}

async function detectGoToolchainStatus(): Promise<GoToolchainStatus> {
  if (!(await detectBinary("go"))) {
    return "missing";
  }
  try {
    const result = await runCommandWithTimeout(["go", "version"], {
      timeoutMs: 5_000,
    });
    if (result.code !== 0) {
      return "too-old";
    }
    const version = parseGoVersion(`${result.stdout}\n${result.stderr}`);
    return version && isGoVersionUsableForAutoInstall(version) ? "usable" : "too-old";
  } catch {
    return "too-old";
  }
}

function summarizeInstallFailure(message: string): string | undefined {
  const cleaned = message.replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "").trim();
  if (!cleaned) {
    return undefined;
  }
  const maxLen = 140;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function formatSkillHint(skill: {
  description?: string;
  install: Array<{ label: string }>;
}): string {
  const desc = skill.description?.trim();
  const installLabel = skill.install[0]?.label?.trim();
  const combined = desc && installLabel ? `${desc} — ${installLabel}` : desc || installLabel;
  if (!combined) {
    return "install";
  }
  const maxLen = 90;
  return combined.length > maxLen ? `${combined.slice(0, maxLen - 1)}…` : combined;
}

function formatSkippedInstallReason(reason: SkippedInstallReason): string {
  switch (reason) {
    case "brew":
      return "Homebrew";
    case "go":
      return `Go ${MIN_AUTO_GO_MAJOR}.${MIN_AUTO_GO_MINOR}+`;
    case "uv":
      return "uv";
  }
  return reason;
}

function formatSkillNames(names: string[]): string {
  const visible = names.slice(0, SKIPPED_INSTALL_NAME_LIMIT);
  const suffix = names.length > visible.length ? ` (+${names.length - visible.length} more)` : "";
  return `${visible.join(", ")}${suffix}`;
}

function formatSkippedInstallNote(
  skipped: Array<{ skill: OnboardInstallSkill; reason: SkippedInstallReason }>,
): string {
  const byReason = new Map<SkippedInstallReason, string[]>();
  for (const item of skipped) {
    const names = byReason.get(item.reason) ?? [];
    names.push(item.skill.name);
    byReason.set(item.reason, names);
  }
  const lines = [t("wizard.skills.manualPrereqsIntro")];
  for (const reason of ["brew", "go", "uv"] as const) {
    const names = byReason.get(reason);
    if (!names || names.length === 0) {
      continue;
    }
    lines.push(`${formatSkippedInstallReason(reason)}: ${formatSkillNames(names)}`);
  }
  lines.push(t("wizard.skills.manualPrereqsDoctorHint"));
  return lines.join("\n");
}

function isBrewOnlyInstallableSkill(skill: {
  install: Array<{ kind: string }>;
  missing: { bins: string[] };
}): boolean {
  return (
    skill.install.length > 0 &&
    skill.missing.bins.length > 0 &&
    skill.install.every((option) => option.kind === "brew")
  );
}

function isTrustedAutoInstallableSkill(skill: { bundled: boolean; source: string }): boolean {
  // Onboarding can auto-run bundled recipes without another prompt. Workspace
  // skill metadata is mutable project input, so those installs stay explicit.
  return skill.bundled && skill.source === "openclaw-bundled";
}

function isNodeManagerChoice(value: unknown): value is NodeManagerChoice {
  return value === "npm" || value === "pnpm" || value === "bun";
}

async function resolveInstallerReadiness(
  kind: string,
  checks: {
    detectBrewOnce: () => Promise<boolean>;
    detectGoOnce: () => Promise<GoToolchainStatus>;
    detectUvOnce: () => Promise<boolean>;
  },
): Promise<InstallerReadiness> {
  switch (kind) {
    case "brew":
      if (!supportsHomebrewPrompt(process.platform)) {
        return { ready: false, reason: "brew" };
      }
      return (await checks.detectBrewOnce()) ? { ready: true } : { ready: false, reason: "brew" };
    case "go": {
      const status = await checks.detectGoOnce();
      if (status === "usable") {
        return { ready: true };
      }
      if (
        status === "missing" &&
        supportsHomebrewPrompt(process.platform) &&
        (await checks.detectBrewOnce())
      ) {
        return { ready: true };
      }
      return { ready: false, reason: "go" };
    }
    case "uv":
      if (await checks.detectUvOnce()) {
        return { ready: true };
      }
      return supportsHomebrewPrompt(process.platform) && (await checks.detectBrewOnce())
        ? { ready: true }
        : { ready: false, reason: "uv" };
    default:
      return { ready: true };
  }
}

function resolveDefaultNodeManager(
  config: OpenClawConfig,
  requested: NodeManagerChoice | undefined,
  runtime: RuntimeEnv,
): NodeManagerChoice {
  if (requested !== undefined) {
    if (!isNodeManagerChoice(requested)) {
      runtime.error('Invalid --node-manager. Use "npm", "pnpm", or "bun".');
      runtime.exit(1);
      return "npm";
    }
    return requested;
  }
  const existing = config.skills?.install?.nodeManager;
  return existing === "npm" || existing === "pnpm" || existing === "bun" ? existing : "npm";
}

/** Runs the interactive skills setup step and returns the updated config. */
export async function setupSkills(
  cfg: OpenClawConfig,
  workspaceDir: string,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options: { nodeManager?: NodeManagerChoice } = {},
): Promise<OpenClawConfig> {
  const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  const eligible = report.skills.filter((s) => s.eligible);
  const unsupportedOs = report.skills.filter(
    (s) => !s.disabled && !s.blockedByAllowlist && s.missing.os.length > 0,
  );
  const missing = report.skills.filter(
    (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist && s.missing.os.length === 0,
  );
  const blocked = report.skills.filter((s) => s.blockedByAllowlist);

  await prompter.note(
    [
      `Eligible: ${eligible.length}`,
      `Missing requirements: ${missing.length}`,
      `Unsupported on this OS: ${unsupportedOs.length}`,
      `Blocked by allowlist: ${blocked.length}`,
    ].join("\n"),
    t("wizard.skills.statusTitle"),
  );

  const baseInstallable = missing.filter(
    (skill) =>
      skill.install.length > 0 &&
      skill.missing.bins.length > 0 &&
      isTrustedAutoInstallableSkill(skill),
  );
  let brewAvailable: boolean | undefined;
  const detectBrewOnce = async () => {
    // Brew detection can shell out; cache it for the whole skills step because
    // install filtering and prompts both need the same answer.
    brewAvailable ??= (await detectBinary("brew")) || resolveBrewExecutable() !== undefined;
    return brewAvailable;
  };
  let uvAvailable: boolean | undefined;
  const detectUvOnce = async () => {
    uvAvailable ??= await detectBinary("uv");
    return uvAvailable;
  };
  let goToolchainStatus: GoToolchainStatus | undefined;
  const detectGoOnce = async () => {
    goToolchainStatus ??= await detectGoToolchainStatus();
    return goToolchainStatus;
  };
  const inLinuxContainer = process.platform === "linux" && isContainerEnvironment();
  let installable = baseInstallable;
  if (inLinuxContainer && baseInstallable.length > 0 && !(await detectBrewOnce())) {
    // Linux containers without brew cannot use brew-only recipes reliably; hide
    // them from install selection and leave manual instructions in the note.
    const hiddenBrewOnly = baseInstallable.filter(isBrewOnlyInstallableSkill);
    installable = baseInstallable.filter((skill) => !isBrewOnlyInstallableSkill(skill));
    if (hiddenBrewOnly.length > 0) {
      await prompter.note(
        [t("wizard.skills.containerBrewHidden"), t("wizard.skills.containerBrewManual")].join("\n"),
        t("wizard.skills.containerInstallsTitle"),
      );
    }
  }
  const candidateInstallable = installable;
  const needsBrewPrompt =
    supportsHomebrewPrompt(process.platform) &&
    candidateInstallable.some((skill) => skill.install.some((option) => option.kind === "brew")) &&
    !(await detectBrewOnce());
  const readyInstallable: typeof installable = [];
  const skippedInstallable: Array<{
    skill: OnboardInstallSkill;
    reason: SkippedInstallReason;
  }> = [];
  for (const skill of candidateInstallable) {
    const primaryInstall = skill.install[0];
    if (!primaryInstall) {
      continue;
    }
    const readiness = await resolveInstallerReadiness(primaryInstall.kind, {
      detectBrewOnce,
      detectGoOnce,
      detectUvOnce,
    });
    if (readiness.ready) {
      readyInstallable.push(skill);
    } else {
      skippedInstallable.push({ skill, reason: readiness.reason });
    }
  }
  installable = readyInstallable;
  if (needsBrewPrompt) {
    await prompter.note(
      [
        "Many skill dependencies are shipped via Homebrew.",
        "Without brew, you'll need to build from source or download releases manually.",
        "",
        "Install Homebrew:",
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      ].join("\n"),
      t("wizard.skills.homebrewRecommendedTitle"),
    );
  }
  if (skippedInstallable.length > 0) {
    await prompter.note(
      formatSkippedInstallNote(skippedInstallable),
      t("wizard.skills.manualPrereqsTitle"),
    );
  }
  let next: OpenClawConfig = cfg;
  if (installable.length === 0 && missing.length === 0) {
    await prompter.note(
      [
        "No missing skill dependencies to install.",
        `To inspect available skills, run: ${formatCliCommand("openclaw skills list --verbose")}`,
        `To check skill status, run: ${formatCliCommand("openclaw skills check")}`,
      ].join("\n"),
      t("wizard.skills.allReadyTitle") ?? "All skills ready",
    );
    return next;
  }
  if (installable.length > 0) {
    await prompter.note(
      installable.map((skill) => `${skill.name}: ${formatSkillHint(skill)}`).join("\n"),
      t("wizard.skills.installDeps"),
    );
    const selectedSkills = installable;

    const needsNodeManagerPrompt = selectedSkills.some((skill) =>
      skill.install.some((option) => option.kind === "node"),
    );
    if (needsNodeManagerPrompt) {
      // Persist the package manager before invoking installers so node recipes
      // and later skill lifecycle commands agree on the selected tool.
      const nodeManager = resolveDefaultNodeManager(next, options.nodeManager, runtime);
      next = {
        ...next,
        skills: {
          ...next.skills,
          install: {
            ...next.skills?.install,
            nodeManager,
          },
        },
      };
    }

    for (const target of selectedSkills) {
      if (target.install.length === 0) {
        continue;
      }
      const installId = target.install[0]?.id;
      if (!installId) {
        continue;
      }
      // Onboarding installs the primary recipe only; alternative recipes remain
      // visible through `openclaw skills list --verbose`.
      const spin = prompter.progress(t("wizard.skills.installing", { name: target.name }));
      const result = await installSkill({
        workspaceDir,
        skillName: target.name,
        installId,
        config: next,
      });
      const warnings = result.warnings ?? [];
      if (result.ok) {
        spin.stop(
          warnings.length > 0
            ? t("wizard.skills.installedWithWarnings", { name: target.name })
            : t("wizard.skills.installed", { name: target.name }),
        );
        for (const warning of warnings) {
          runtime.log(warning);
        }
        continue;
      }
      const code = result.code == null ? "" : ` (exit ${result.code})`;
      const detail = summarizeInstallFailure(result.message);
      spin.stop(
        t("wizard.skills.installFailed", {
          name: target.name,
          code,
          detail: detail ? ` - ${detail}` : "",
        }),
      );
      for (const warning of warnings) {
        runtime.log(warning);
      }
      if (result.stderr) {
        runtime.log(result.stderr.trim());
      } else if (result.stdout) {
        runtime.log(result.stdout.trim());
      }
      runtime.log(
        `Tip: run \`${formatCliCommand("openclaw doctor")}\` to review skills + requirements.`,
      );
      runtime.log(t("wizard.skills.docsLine"));
    }
  }

  return next;
}
