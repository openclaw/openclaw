/**
 * Terminal output formatting for affiliate-check
 * Clean, readable output without external dependencies
 */

import type { Program } from "./api";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";

function rewardLabel(program: Program): string {
  const value = program.reward_value || "—";
  const typeMap: Record<string, string> = {
    cps_recurring: "recurring",
    cps_one_time: "one-time",
    cps_lifetime: "lifetime",
    cpl: "per lead",
    cpc: "per click",
  };
  const type = program.reward_type ? typeMap[program.reward_type] || program.reward_type : "";
  return type ? `${value} ${type}` : value;
}

function cookieLabel(days: number | null): string {
  if (!days) return "—";
  return `${days} days`;
}

function starsLabel(count: number): string {
  if (count === 0) return "—";
  return `★ ${count}`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

export function formatProgramCard(p: Program): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${BOLD}${WHITE}${p.name}${RESET}`);
  lines.push(`  ${DIM}${"─".repeat(Math.max(p.name.length, 25))}${RESET}`);
  lines.push(`  ${CYAN}Commission:${RESET}  ${rewardLabel(p)}`);
  lines.push(`  ${CYAN}Cookie:${RESET}      ${cookieLabel(p.cookie_days)}`);
  lines.push(`  ${CYAN}Stars:${RESET}       ${starsLabel(p.stars_count)}`);
  if (p.category) {
    lines.push(`  ${CYAN}Category:${RESET}    ${p.category}`);
  }
  if (p.tags?.length) {
    lines.push(`  ${CYAN}Tags:${RESET}        ${p.tags.join(", ")}`);
  }
  if (p.url) {
    lines.push(`  ${CYAN}URL:${RESET}         ${DIM}${p.url}${RESET}`);
  }
  if (p.description) {
    lines.push(`  ${DIM}${truncate(p.description, 80)}${RESET}`);
  }
  return lines.join("\n");
}

export function formatProgramTable(programs: Program[]): string {
  if (programs.length === 0) return "\n  No programs found.\n";

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  ${BOLD}${WHITE}${"Name".padEnd(25)} ${"Commission".padEnd(20)} ${"Cookie".padEnd(10)} ${"Stars".padEnd(8)}${RESET}`,
  );
  lines.push(`  ${DIM}${"─".repeat(65)}${RESET}`);

  for (const p of programs) {
    const name = truncate(p.name, 24).padEnd(25);
    const commission = truncate(rewardLabel(p), 19).padEnd(20);
    const cookie = cookieLabel(p.cookie_days).padEnd(10);
    const stars = starsLabel(p.stars_count).padEnd(8);
    lines.push(`  ${name} ${commission} ${cookie} ${stars}`);
  }

  lines.push("");
  return lines.join("\n");
}

export function formatComparison(programs: Program[]): string {
  if (programs.length < 2) return "\n  Need at least 2 programs to compare.\n";

  const lines: string[] = [];
  const fields = [
    { label: "Commission", fn: (p: Program) => rewardLabel(p) },
    { label: "Cookie", fn: (p: Program) => cookieLabel(p.cookie_days) },
    { label: "Stars", fn: (p: Program) => starsLabel(p.stars_count) },
    { label: "Category", fn: (p: Program) => p.category || "—" },
    { label: "Tags", fn: (p: Program) => p.tags?.join(", ") || "—" },
    { label: "URL", fn: (p: Program) => p.url || "—" },
  ];

  // Header
  lines.push("");
  const header = `  ${"".padEnd(15)} ${programs.map((p) => BOLD + truncate(p.name, 24).padEnd(25) + RESET).join(" ")}`;
  lines.push(header);
  lines.push(`  ${DIM}${"─".repeat(15 + 26 * programs.length)}${RESET}`);

  // Rows
  for (const field of fields) {
    const row = `  ${CYAN}${field.label.padEnd(15)}${RESET}${programs.map((p) => truncate(field.fn(p), 24).padEnd(25)).join(" ")}`;
    lines.push(row);
  }

  lines.push("");
  return lines.join("\n");
}

export function formatFreeTierNotice(): string {
  return `\n  ${YELLOW}Free tier: max 5 results, no pagination.${RESET}\n  ${DIM}Get unlimited → list.affitor.com/settings → API Keys (free)${RESET}\n`;
}

export function formatError(message: string): string {
  return `\n  ${BOLD}\x1b[31mError:${RESET} ${message}\n`;
}

export function formatStatus(info: {
  uptime: string;
  cache: { entries: number; oldestAge: string };
  apiKey: boolean;
  port: number;
}): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${BOLD}${WHITE}affiliate-check status${RESET}`);
  lines.push(`  ${DIM}${"─".repeat(30)}${RESET}`);
  lines.push(`  ${CYAN}Server:${RESET}    running on port ${info.port}`);
  lines.push(`  ${CYAN}Uptime:${RESET}    ${info.uptime}`);
  lines.push(
    `  ${CYAN}Cache:${RESET}     ${info.cache.entries} entries (oldest: ${info.cache.oldestAge})`,
  );
  lines.push(
    `  ${CYAN}API Key:${RESET}   ${info.apiKey ? `${GREEN}configured${RESET}` : `${YELLOW}not set (free tier)${RESET}`}`,
  );
  lines.push("");
  return lines.join("\n");
}
