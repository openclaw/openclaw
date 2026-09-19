import { note } from "../../packages/terminal-core/src/note.js";
import type { ServiceConfigAudit, ServiceConfigIssue } from "../daemon/service-audit.js";

export function formatServiceConfigIssues(issues: ServiceConfigIssue[]): string[] {
  return issues.map((issue) =>
    issue.detail ? `- ${issue.message} (${issue.detail})` : `- ${issue.message}`,
  );
}

export function reportServiceDefinitionDrift(audit: ServiceConfigAudit) {
  const messages = [
    ...(audit.definitionDrift ?? []).map((fact) => fact.message),
    ...(audit.definitionDriftError ? [audit.definitionDriftError] : []),
  ];
  if (messages.length > 0) {
    note(messages.map((message) => `- ${message}`).join("\n"), "Gateway service definition");
  }
}
