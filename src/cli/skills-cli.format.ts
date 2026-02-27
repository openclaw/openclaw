import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import type { SkillLoadDiagnostic } from "../agents/skills.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";

export type SkillsListOptions = {
  json?: boolean;
  eligible?: boolean;
  verbose?: boolean;
};

export type SkillInfoOptions = {
  json?: boolean;
};

export type SkillsCheckOptions = {
  json?: boolean;
};

function appendClawHubHint(output: string, json?: boolean): string {
  if (json) {
    return output;
  }
  return `${output}\n\nTip: use \`npx clawhub\` to search, install, and sync skills.`;
}

function formatSkillStatus(skill: SkillStatusEntry): string {
  if (skill.eligible) {
    return theme.success("\u2713 ready");
  }
  if (skill.disabled) {
    return theme.warn("\u23F8 disabled");
  }
  if (skill.blockedByAllowlist) {
    return theme.warn("\uD83D\uDEAB blocked");
  }
  return theme.error("\u2717 missing");
}

function formatSkillName(skill: SkillStatusEntry): string {
  const emoji = skill.emoji ?? "\uD83D\uDCE6";
  return `${emoji} ${theme.command(skill.name)}`;
}

function formatSkillMissingSummary(skill: SkillStatusEntry): string {
  const missing: string[] = [];
  if (skill.missing.bins.length > 0) {
    missing.push(`bins: ${skill.missing.bins.join(", ")}`);
  }
  if (skill.missing.anyBins.length > 0) {
    missing.push(`anyBins: ${skill.missing.anyBins.join(", ")}`);
  }
  if (skill.missing.env.length > 0) {
    missing.push(`env: ${skill.missing.env.join(", ")}`);
  }
  if (skill.missing.config.length > 0) {
    missing.push(`config: ${skill.missing.config.join(", ")}`);
  }
  if (skill.missing.os.length > 0) {
    missing.push(`os: ${skill.missing.os.join(", ")}`);
  }
  return missing.join("; ");
}

/** Derive a short name from a diagnostic's file path (parent dir name or filename). */
function diagnosticSkillName(diag: SkillLoadDiagnostic): string {
  if (!diag.path) {
    return "(unknown)";
  }
  const parts = diag.path.split("/");
  const fileName = parts[parts.length - 1] ?? "";
  // For SKILL.md, use the parent directory name as the skill identifier.
  if (fileName.toLowerCase() === "skill.md" && parts.length >= 2) {
    return parts[parts.length - 2] ?? "(unknown)";
  }
  return fileName;
}

export function formatSkillsList(report: SkillStatusReport, opts: SkillsListOptions): string {
  const skills = opts.eligible ? report.skills.filter((s) => s.eligible) : report.skills;
  const diagnostics = report.diagnostics ?? [];

  if (opts.json) {
    const jsonReport = {
      workspaceDir: report.workspaceDir,
      managedSkillsDir: report.managedSkillsDir,
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        emoji: s.emoji,
        eligible: s.eligible,
        disabled: s.disabled,
        blockedByAllowlist: s.blockedByAllowlist,
        source: s.source,
        bundled: s.bundled,
        primaryEnv: s.primaryEnv,
        homepage: s.homepage,
        missing: s.missing,
      })),
      ...(diagnostics.length > 0
        ? {
            diagnostics: diagnostics.map((d) => ({
              type: d.type,
              message: d.message,
              path: d.path,
              source: d.source,
            })),
          }
        : {}),
    };
    return JSON.stringify(jsonReport, null, 2);
  }

  if (skills.length === 0 && diagnostics.length === 0) {
    const message = opts.eligible
      ? `No eligible skills found. Run \`${formatCliCommand("openclaw skills list")}\` to see all skills.`
      : "No skills found.";
    return appendClawHubHint(message, opts.json);
  }

  const eligible = skills.filter((s) => s.eligible);
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const rows = skills.map((skill) => {
    const missing = formatSkillMissingSummary(skill);
    return {
      Status: formatSkillStatus(skill),
      Skill: formatSkillName(skill),
      Description: theme.muted(skill.description),
      Source: skill.source ?? "",
      Missing: missing ? theme.warn(missing) : "",
    };
  });

  // Append diagnostic rows for skills that failed to load (e.g. YAML parse errors).
  for (const diag of diagnostics) {
    const name = diagnosticSkillName(diag);
    rows.push({
      Status: theme.warn("!! parse error"),
      Skill: theme.warn(name),
      Description: theme.warn(diag.message),
      Source: diag.source ?? "",
      Missing: "",
    });
  }

  const columns = [
    { key: "Status", header: "Status", minWidth: 10 },
    { key: "Skill", header: "Skill", minWidth: 18, flex: true },
    { key: "Description", header: "Description", minWidth: 24, flex: true },
    { key: "Source", header: "Source", minWidth: 10 },
  ];
  if (opts.verbose) {
    columns.push({ key: "Missing", header: "Missing", minWidth: 18, flex: true });
  }

  const lines: string[] = [];
  lines.push(
    `${theme.heading("Skills")} ${theme.muted(`(${eligible.length}/${skills.length} ready)`)}`,
  );
  lines.push(
    renderTable({
      width: tableWidth,
      columns,
      rows,
    }).trimEnd(),
  );

  return appendClawHubHint(lines.join("\n"), opts.json);
}

export function formatSkillInfo(
  report: SkillStatusReport,
  skillName: string,
  opts: SkillInfoOptions,
): string {
  const skill = report.skills.find((s) => s.name === skillName || s.skillKey === skillName);

  if (!skill) {
    if (opts.json) {
      return JSON.stringify({ error: "not found", skill: skillName }, null, 2);
    }
    return appendClawHubHint(
      `Skill "${skillName}" not found. Run \`${formatCliCommand("openclaw skills list")}\` to see available skills.`,
      opts.json,
    );
  }

  if (opts.json) {
    return JSON.stringify(skill, null, 2);
  }

  const lines: string[] = [];
  const emoji = skill.emoji ?? "\uD83D\uDCE6";
  const status = skill.eligible
    ? theme.success("\u2713 Ready")
    : skill.disabled
      ? theme.warn("\u23F8 Disabled")
      : skill.blockedByAllowlist
        ? theme.warn("\uD83D\uDEAB Blocked by allowlist")
        : theme.error("\u2717 Missing requirements");

  lines.push(`${emoji} ${theme.heading(skill.name)} ${status}`);
  lines.push("");
  lines.push(skill.description);
  lines.push("");

  lines.push(theme.heading("Details:"));
  lines.push(`${theme.muted("  Source:")} ${skill.source}`);
  lines.push(`${theme.muted("  Path:")} ${shortenHomePath(skill.filePath)}`);
  if (skill.homepage) {
    lines.push(`${theme.muted("  Homepage:")} ${skill.homepage}`);
  }
  if (skill.primaryEnv) {
    lines.push(`${theme.muted("  Primary env:")} ${skill.primaryEnv}`);
  }

  const hasRequirements =
    skill.requirements.bins.length > 0 ||
    skill.requirements.anyBins.length > 0 ||
    skill.requirements.env.length > 0 ||
    skill.requirements.config.length > 0 ||
    skill.requirements.os.length > 0;

  if (hasRequirements) {
    lines.push("");
    lines.push(theme.heading("Requirements:"));
    if (skill.requirements.bins.length > 0) {
      const binsStatus = skill.requirements.bins.map((bin) => {
        const missing = skill.missing.bins.includes(bin);
        return missing ? theme.error(`\u2717 ${bin}`) : theme.success(`\u2713 ${bin}`);
      });
      lines.push(`${theme.muted("  Binaries:")} ${binsStatus.join(", ")}`);
    }
    if (skill.requirements.anyBins.length > 0) {
      const anyBinsMissing = skill.missing.anyBins.length > 0;
      const anyBinsStatus = skill.requirements.anyBins.map((bin) => {
        const missing = anyBinsMissing;
        return missing ? theme.error(`\u2717 ${bin}`) : theme.success(`\u2713 ${bin}`);
      });
      lines.push(`${theme.muted("  Any binaries:")} ${anyBinsStatus.join(", ")}`);
    }
    if (skill.requirements.env.length > 0) {
      const envStatus = skill.requirements.env.map((env) => {
        const missing = skill.missing.env.includes(env);
        return missing ? theme.error(`\u2717 ${env}`) : theme.success(`\u2713 ${env}`);
      });
      lines.push(`${theme.muted("  Environment:")} ${envStatus.join(", ")}`);
    }
    if (skill.requirements.config.length > 0) {
      const configStatus = skill.requirements.config.map((cfg) => {
        const missing = skill.missing.config.includes(cfg);
        return missing ? theme.error(`\u2717 ${cfg}`) : theme.success(`\u2713 ${cfg}`);
      });
      lines.push(`${theme.muted("  Config:")} ${configStatus.join(", ")}`);
    }
    if (skill.requirements.os.length > 0) {
      const osStatus = skill.requirements.os.map((osName) => {
        const missing = skill.missing.os.includes(osName);
        return missing ? theme.error(`\u2717 ${osName}`) : theme.success(`\u2713 ${osName}`);
      });
      lines.push(`${theme.muted("  OS:")} ${osStatus.join(", ")}`);
    }
  }

  if (skill.install.length > 0 && !skill.eligible) {
    lines.push("");
    lines.push(theme.heading("Install options:"));
    for (const inst of skill.install) {
      lines.push(`  ${theme.warn("\u2192")} ${inst.label}`);
    }
  }

  return appendClawHubHint(lines.join("\n"), opts.json);
}

export function formatSkillsCheck(report: SkillStatusReport, opts: SkillsCheckOptions): string {
  const eligible = report.skills.filter((s) => s.eligible);
  const disabled = report.skills.filter((s) => s.disabled);
  const blocked = report.skills.filter((s) => s.blockedByAllowlist && !s.disabled);
  const missingReqs = report.skills.filter(
    (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
  );
  const diagnostics = report.diagnostics ?? [];

  if (opts.json) {
    return JSON.stringify(
      {
        summary: {
          total: report.skills.length,
          eligible: eligible.length,
          disabled: disabled.length,
          blocked: blocked.length,
          missingRequirements: missingReqs.length,
          parseErrors: diagnostics.length,
        },
        eligible: eligible.map((s) => s.name),
        disabled: disabled.map((s) => s.name),
        blocked: blocked.map((s) => s.name),
        missingRequirements: missingReqs.map((s) => ({
          name: s.name,
          missing: s.missing,
          install: s.install,
        })),
        ...(diagnostics.length > 0
          ? {
              parseErrors: diagnostics.map((d) => ({
                message: d.message,
                path: d.path,
                source: d.source,
              })),
            }
          : {}),
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(theme.heading("Skills Status Check"));
  lines.push("");
  lines.push(`${theme.muted("Total:")} ${report.skills.length}`);
  lines.push(`${theme.success("\u2713")} ${theme.muted("Eligible:")} ${eligible.length}`);
  lines.push(`${theme.warn("\u23F8")} ${theme.muted("Disabled:")} ${disabled.length}`);
  lines.push(
    `${theme.warn("\uD83D\uDEAB")} ${theme.muted("Blocked by allowlist:")} ${blocked.length}`,
  );
  lines.push(
    `${theme.error("\u2717")} ${theme.muted("Missing requirements:")} ${missingReqs.length}`,
  );
  if (diagnostics.length > 0) {
    lines.push(`${theme.warn("!!")} ${theme.muted("Parse errors:")} ${diagnostics.length}`);
  }

  if (eligible.length > 0) {
    lines.push("");
    lines.push(theme.heading("Ready to use:"));
    for (const skill of eligible) {
      const emoji = skill.emoji ?? "\uD83D\uDCE6";
      lines.push(`  ${emoji} ${skill.name}`);
    }
  }

  if (missingReqs.length > 0) {
    lines.push("");
    lines.push(theme.heading("Missing requirements:"));
    for (const skill of missingReqs) {
      const emoji = skill.emoji ?? "\uD83D\uDCE6";
      const missing = formatSkillMissingSummary(skill);
      lines.push(`  ${emoji} ${skill.name} ${theme.muted(`(${missing})`)}`);
    }
  }

  if (diagnostics.length > 0) {
    lines.push("");
    lines.push(theme.heading("Parse errors:"));
    lines.push(
      theme.muted("  These skills failed to load due to YAML/frontmatter errors in SKILL.md."),
    );
    lines.push(theme.muted("  Tip: wrap description values containing `: ` in quotes."));
    for (const diag of diagnostics) {
      const name = diagnosticSkillName(diag);
      const pathHint = diag.path ? ` ${theme.muted(`(${shortenHomePath(diag.path)})`)}` : "";
      lines.push(`  ${theme.warn("!!")} ${name}: ${diag.message}${pathHint}`);
    }
  }

  return appendClawHubHint(lines.join("\n"), opts.json);
}
