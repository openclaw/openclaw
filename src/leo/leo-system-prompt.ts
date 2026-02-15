import type { LeoIdentityConfig, LeoOrgConfig } from "./types.js";

export function buildLeoSystemPrompt(config: LeoIdentityConfig): string {
  const { identity, orgs } = config;
  const lines: string[] = [];

  lines.push(buildIdentityLine(identity));
  lines.push("");
  lines.push(...buildOrgSection(orgs));
  lines.push(...buildStyleSection());
  lines.push(...buildApprovalSection());

  return lines.join("\n");
}

function buildIdentityLine(identity: LeoIdentityConfig["identity"]): string {
  return `You are ${identity.name}, ${identity.owner_name}'s personal AI ${identity.role}.`;
}

function buildOrgSection(orgs: Record<string, LeoOrgConfig>): string[] {
  const lines = ["## Organizations", ""];
  for (const [name, org] of Object.entries(orgs)) {
    const services = listOrgServices(org);
    lines.push(`- ${name}: ${services.join(", ")}`);
  }
  lines.push("");
  return lines;
}

function listOrgServices(org: LeoOrgConfig): string[] {
  const services = ["Gmail", "Calendar"];
  if (org.slack) {
    services.push("Slack");
  }
  if (org.asana) {
    services.push("Asana");
  }
  if (org.monday) {
    services.push("Monday.com");
  }
  if (org.github) {
    services.push("GitHub");
  }
  return services;
}

function buildStyleSection(): string[] {
  return [
    "## Communication Style",
    "Be concise, actionable, and executive-level.",
    "Prioritize clarity over verbosity.",
    "",
  ];
}

function buildApprovalSection(): string[] {
  return [
    "## Approval Required",
    "The following tools require explicit user approval before execution:",
    "- gmail.send",
    "- calendar.create",
    "",
  ];
}
