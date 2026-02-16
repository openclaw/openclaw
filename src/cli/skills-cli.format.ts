import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import type { SkillCapability } from "../agents/skills/types.js";
import { stripAnsi } from "../terminal/ansi.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";

function truncateAnsi(text: string, maxChars: number): string {
  const plain = stripAnsi(text);
  if (Array.from(plain).length <= maxChars) {
    return text;
  }
  // Walk the original string, counting only visible characters
  const ESC = "\u001b";
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < maxChars - 1) {
    if (text[i] === ESC) {
      // Skip ANSI sequence
      if (text[i + 1] === "[") {
        let j = i + 2;
        while (j < text.length && text[j] !== "m") j++;
        i = j + 1;
        continue;
      }
      if (text[i + 1] === "]") {
        const st = text.indexOf(`${ESC}\\`, i + 2);
        if (st >= 0) { i = st + 2; continue; }
      }
    }
    const cp = text.codePointAt(i);
    if (!cp) break;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    visible++;
  }
  // Grab any trailing ANSI reset sequences
  let suffix = "";
  let j = i;
  while (j < text.length && text[j] === ESC) {
    if (text[j + 1] === "[") {
      let k = j + 2;
      while (k < text.length && text[k] !== "m") k++;
      suffix += text.slice(j, k + 1);
      j = k + 1;
    } else {
      break;
    }
  }
  return text.slice(0, i) + "…" + suffix;
}

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

const CAPABILITY_ICONS: Record<SkillCapability, string> = {
  shell: "shell",
  filesystem: "filesystem",
  network: "network",
  browser: "browser",
  sessions: "sessions",
};

function formatCapabilityTags(capabilities: SkillCapability[]): string {
  if (capabilities.length === 0) {
    return "";
  }
  return capabilities.map((cap) => CAPABILITY_ICONS[cap] ?? cap).join(" ");
}

function formatScanBadge(scanResult?: { severity: string }): string {
  if (!scanResult) {
    return "";
  }
  switch (scanResult.severity) {
    case "critical":
      return theme.error("[blocked]");
    case "warn":
      return theme.warn("[warn]");
    case "info":
      return theme.muted("[notice]");
    default:
      return "";
  }
}

function appendClawHubHint(output: string, json?: boolean): string {
  if (json) {
    return output;
  }
  return `${output}\n\nTip: use \`npx clawhub\` to search, install, and sync skills.`;
}

function formatSkillStatus(skill: SkillStatusEntry): string {
  if (skill.scanResult?.severity === "critical") {
    return theme.error("x blocked");
  }
  if (skill.eligible) {
    return theme.success("+ ready");
  }
  if (skill.disabled) {
    return theme.warn("- disabled");
  }
  if (skill.blockedByAllowlist) {
    return theme.warn("x blocked");
  }
  return theme.error("x missing");
}

function formatSkillName(skill: SkillStatusEntry): string {
  const emoji = skill.emoji ?? "📦";
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

export function formatSkillsList(report: SkillStatusReport, opts: SkillsListOptions): string {
  const skills = opts.eligible ? report.skills.filter((s) => s.eligible) : report.skills;

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
        capabilities: s.capabilities,
        scanResult: s.scanResult,
      })),
    };
    return JSON.stringify(jsonReport, null, 2);
  }

  if (skills.length === 0) {
    const message = opts.eligible
      ? `No eligible skills found. Run \`${formatCliCommand("openclaw skills list")}\` to see all skills.`
      : "No skills found.";
    return appendClawHubHint(message, opts.json);
  }

  const eligible = skills.filter((s) => s.eligible);
  const termWidth = process.stdout.columns ?? 120;
  const tableWidth = Math.max(60, termWidth - 1);
  const descLimit = opts.verbose ? 30 : 44;
  const rows = skills.map((skill) => {
    const missing = formatSkillMissingSummary(skill);
    const caps = formatCapabilityTags(skill.capabilities);
    const scan = formatScanBadge(skill.scanResult);
    // Plain text name (no emoji) to avoid double-width alignment issues
    const name = theme.command(skill.name);
    const skillLabel = caps ? `${name} ${theme.muted(caps)}` : name;
    // Truncate description as plain text BEFORE applying ANSI
    const rawDesc = skill.description.length > descLimit
      ? skill.description.slice(0, descLimit - 1) + "..."
      : skill.description;
    return {
      Status: formatSkillStatus(skill),
      Skill: skillLabel,
      Scan: scan,
      Description: theme.muted(rawDesc),
      Source: skill.source ?? "",
      Missing: missing ? theme.warn(missing) : "",
    };
  });

  const columns = [
    { key: "Status", header: "Status", minWidth: 10 },
    { key: "Skill", header: "Skill", minWidth: 16 },
    { key: "Description", header: "Description", minWidth: 20, maxWidth: descLimit + 4 },
    { key: "Source", header: "Source", minWidth: 10 },
  ];
  if (opts.verbose) {
    columns.push({ key: "Scan", header: "Scan", minWidth: 10 });
    columns.push({ key: "Missing", header: "Missing", minWidth: 14 });
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

  const status = skill.scanResult?.severity === "critical"
    ? theme.error("x Blocked (security)")
    : skill.eligible
      ? theme.success("+ Ready")
      : skill.disabled
        ? theme.warn("- Disabled")
        : skill.blockedByAllowlist
          ? theme.warn("x Blocked by allowlist")
          : theme.error("x Missing requirements");

  const lines: string[] = [];
  lines.push(`${theme.heading(skill.name)} ${status}`);
  lines.push("");
  lines.push(skill.description);

  // Details table
  const detailRows: Array<Record<string, string>> = [
    { Field: "Source", Value: skill.source },
    { Field: "Path", Value: shortenHomePath(skill.filePath) },
  ];
  if (skill.homepage) {
    detailRows.push({ Field: "Homepage", Value: skill.homepage });
  }
  if (skill.primaryEnv) {
    detailRows.push({ Field: "Primary env", Value: skill.primaryEnv });
  }
  lines.push("");
  lines.push(
    renderTable({
      columns: [
        { key: "Field", header: "Detail", minWidth: 12 },
        { key: "Value", header: "Value", minWidth: 20 },
      ],
      rows: detailRows,
    }).trimEnd(),
  );

  // Capabilities table
  if (skill.capabilities.length > 0) {
    const capLabels: Record<SkillCapability, string> = {
      shell: "Run shell commands",
      filesystem: "Read and write files",
      network: "Make outbound HTTP requests",
      browser: "Control browser sessions",
      sessions: "Spawn sub-sessions and agents",
    };
    const capRows = skill.capabilities.map((cap) => ({
      Capability: CAPABILITY_ICONS[cap] ?? cap,
      Name: cap,
      Description: capLabels[cap] ?? cap,
    }));
    lines.push("");
    lines.push(theme.heading("Capabilities"));
    lines.push(
      renderTable({
        columns: [
          { key: "Capability", header: "Icon", minWidth: 6 },
          { key: "Name", header: "Capability", minWidth: 12 },
          { key: "Description", header: "Description", minWidth: 20 },
        ],
        rows: capRows,
      }).trimEnd(),
    );
  }

  // Security table
  if (skill.scanResult) {
    const scanBadge = formatScanBadge(skill.scanResult);
    const secRows: Array<Record<string, string>> = [
      { Field: "Scan", Value: scanBadge || theme.success("+ clean") },
    ];
    lines.push("");
    lines.push(theme.heading("Security"));
    lines.push(
      renderTable({
        columns: [
          { key: "Field", header: "Check", minWidth: 10 },
          { key: "Value", header: "Result", minWidth: 14 },
        ],
        rows: secRows,
      }).trimEnd(),
    );
  }

  // Requirements table
  const reqRows: Array<Record<string, string>> = [];
  for (const bin of skill.requirements.bins) {
    const ok = !skill.missing.bins.includes(bin);
    reqRows.push({ Type: "bin", Name: bin, Status: ok ? theme.success("+ ok") : theme.error("x missing") });
  }
  for (const bin of skill.requirements.anyBins) {
    const ok = skill.missing.anyBins.length === 0;
    reqRows.push({ Type: "anyBin", Name: bin, Status: ok ? theme.success("+ ok") : theme.error("x missing") });
  }
  for (const env of skill.requirements.env) {
    const ok = !skill.missing.env.includes(env);
    reqRows.push({ Type: "env", Name: env, Status: ok ? theme.success("+ ok") : theme.error("x missing") });
  }
  for (const cfg of skill.requirements.config) {
    const ok = !skill.missing.config.includes(cfg);
    reqRows.push({ Type: "config", Name: cfg, Status: ok ? theme.success("+ ok") : theme.error("x missing") });
  }
  for (const osName of skill.requirements.os) {
    const ok = !skill.missing.os.includes(osName);
    reqRows.push({ Type: "os", Name: osName, Status: ok ? theme.success("+ ok") : theme.error("x missing") });
  }
  if (reqRows.length > 0) {
    lines.push("");
    lines.push(theme.heading("Requirements"));
    lines.push(
      renderTable({
        columns: [
          { key: "Type", header: "Type", minWidth: 8 },
          { key: "Name", header: "Name", minWidth: 14 },
          { key: "Status", header: "Status", minWidth: 10 },
        ],
        rows: reqRows,
      }).trimEnd(),
    );
  }

  // Install options table
  if (skill.install.length > 0 && !skill.eligible) {
    const installRows = skill.install.map((inst) => ({
      Kind: inst.kind,
      Label: inst.label,
    }));
    lines.push("");
    lines.push(theme.heading("Install options"));
    lines.push(
      renderTable({
        columns: [
          { key: "Kind", header: "Kind", minWidth: 8 },
          { key: "Label", header: "Action", minWidth: 20 },
        ],
        rows: installRows,
      }).trimEnd(),
    );
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

  if (opts.json) {
    return JSON.stringify(
      {
        summary: {
          total: report.skills.length,
          eligible: eligible.length,
          disabled: disabled.length,
          blocked: blocked.length,
          missingRequirements: missingReqs.length,
        },
        eligible: eligible.map((s) => s.name),
        disabled: disabled.map((s) => s.name),
        blocked: blocked.map((s) => s.name),
        missingRequirements: missingReqs.map((s) => ({
          name: s.name,
          missing: s.missing,
          install: s.install,
        })),
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(theme.heading("Skills Status Check"));

  // Summary table
  const summaryRows = [
    { Metric: "Total", Count: String(report.skills.length) },
    { Metric: theme.success("Eligible"), Count: String(eligible.length) },
    { Metric: theme.warn("Disabled"), Count: String(disabled.length) },
    { Metric: theme.warn("Blocked (allowlist)"), Count: String(blocked.length) },
    { Metric: theme.error("Missing requirements"), Count: String(missingReqs.length) },
  ];
  lines.push(
    renderTable({
      columns: [
        { key: "Metric", header: "Status", minWidth: 20 },
        { key: "Count", header: "Count", minWidth: 6 },
      ],
      rows: summaryRows,
    }).trimEnd(),
  );

  // Capability summary for community skills
  const communitySkills = report.skills.filter(
    (s) => s.source === "openclaw-managed" && !s.bundled,
  );
  if (communitySkills.length > 0) {
    const capCounts = new Map<SkillCapability, string[]>();
    for (const skill of communitySkills) {
      for (const cap of skill.capabilities) {
        const list = capCounts.get(cap) ?? [];
        list.push(skill.name);
        capCounts.set(cap, list);
      }
    }
    if (capCounts.size > 0) {
      const capRows = [...capCounts.entries()].map(([cap, names]) => ({
        Icon: CAPABILITY_ICONS[cap] ?? cap,
        Capability: cap,
        Count: String(names.length),
        Skills: names.join(", "),
      }));
      lines.push("");
      lines.push(theme.heading("Community skill capabilities"));
      lines.push(
        renderTable({
          columns: [
            { key: "Icon", header: "Icon", minWidth: 5 },
            { key: "Capability", header: "Capability", minWidth: 12 },
            { key: "Count", header: "#", minWidth: 4 },
            { key: "Skills", header: "Skills", minWidth: 16 },
          ],
          rows: capRows,
        }).trimEnd(),
      );
    }

    // Scan results summary
    const scanClean = communitySkills.filter(
      (s) => !s.scanResult || s.scanResult.severity === "clean",
    ).length;
    const scanWarn = communitySkills.filter((s) => s.scanResult?.severity === "warn").length;
    const scanBlocked = communitySkills.filter(
      (s) => s.scanResult?.severity === "critical",
    ).length;
    if (scanWarn > 0 || scanBlocked > 0) {
      const scanRows = [
        { Result: theme.success("Clean"), Count: String(scanClean) },
        ...(scanWarn > 0 ? [{ Result: theme.warn("Warning"), Count: String(scanWarn) }] : []),
        ...(scanBlocked > 0 ? [{ Result: theme.error("Blocked"), Count: String(scanBlocked) }] : []),
      ];
      lines.push("");
      lines.push(theme.heading("Scan results"));
      lines.push(
        renderTable({
          columns: [
            { key: "Result", header: "Result", minWidth: 10 },
            { key: "Count", header: "#", minWidth: 4 },
          ],
          rows: scanRows,
        }).trimEnd(),
      );
    }
  }

  // Ready skills table
  if (eligible.length > 0) {
    const readyRows = eligible.map((skill) => {
      const caps = formatCapabilityTags(skill.capabilities);
      return {
        Skill: theme.command(skill.name),
        Caps: caps ? theme.muted(caps) : "",
        Source: skill.source,
      };
    });
    lines.push("");
    lines.push(theme.heading("Ready to use"));
    lines.push(
      renderTable({
        columns: [
          { key: "Skill", header: "Skill", minWidth: 16 },
          { key: "Caps", header: "Caps", minWidth: 8 },
          { key: "Source", header: "Source", minWidth: 10 },
        ],
        rows: readyRows,
      }).trimEnd(),
    );
  }

  // Missing requirements
  if (missingReqs.length > 0) {
    lines.push("");
    lines.push(theme.heading("Missing requirements:"));
    for (const skill of missingReqs) {
      const emoji = skill.emoji ?? "📦";
      const missing = formatSkillMissingSummary(skill);
      lines.push(`  ${emoji} ${skill.name} ${theme.muted(`(${missing})`)}`);
    }
  }

  return appendClawHubHint(lines.join("\n"), opts.json);
}
