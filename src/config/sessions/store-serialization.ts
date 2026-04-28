import type { SessionEntry } from "./types.js";

function compactSkillsSnapshotForPersistence(
  snapshot: SessionEntry["skillsSnapshot"],
): SessionEntry["skillsSnapshot"] {
  if (!snapshot?.prompt) {
    return snapshot;
  }
  return {
    ...snapshot,
    prompt: "",
    promptOmitted: true,
  };
}

function compactSystemPromptReportForPersistence(
  report: SessionEntry["systemPromptReport"],
): SessionEntry["systemPromptReport"] {
  if (!report) {
    return report;
  }
  const reportRecord = report as SessionEntry["systemPromptReport"] & {
    injectedWorkspaceFiles?: unknown;
    skills?: { entries?: unknown };
    tools?: { entries?: unknown };
  };
  const injectedWorkspaceFiles = Array.isArray(reportRecord.injectedWorkspaceFiles)
    ? reportRecord.injectedWorkspaceFiles
    : [];
  const skillEntries = Array.isArray(reportRecord.skills?.entries)
    ? reportRecord.skills.entries
    : [];
  const toolEntries = Array.isArray(reportRecord.tools?.entries) ? reportRecord.tools.entries : [];
  const hasDetails =
    injectedWorkspaceFiles.length > 0 || skillEntries.length > 0 || toolEntries.length > 0;
  if (!hasDetails && report.detailsOmitted) {
    return report;
  }
  const compacted: SessionEntry["systemPromptReport"] = {
    ...report,
    detailsOmitted: true,
  };
  if (Array.isArray(reportRecord.injectedWorkspaceFiles)) {
    compacted.injectedWorkspaceFiles = [];
  }
  if (reportRecord.skills && Array.isArray(reportRecord.skills.entries)) {
    compacted.skills = {
      ...report.skills,
      entries: [],
    };
  }
  if (reportRecord.tools && Array.isArray(reportRecord.tools.entries)) {
    compacted.tools = {
      ...report.tools,
      entries: [],
    };
  }
  return compacted;
}

export function compactSessionEntryForPersistence(entry: SessionEntry): SessionEntry {
  const skillsSnapshot = compactSkillsSnapshotForPersistence(entry.skillsSnapshot);
  const systemPromptReport = compactSystemPromptReportForPersistence(entry.systemPromptReport);
  if (skillsSnapshot === entry.skillsSnapshot && systemPromptReport === entry.systemPromptReport) {
    return entry;
  }
  return {
    ...entry,
    skillsSnapshot,
    systemPromptReport,
  };
}

export function compactSessionStoreForPersistence(
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  let next: Record<string, SessionEntry> | undefined;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const compacted = compactSessionEntryForPersistence(entry);
    if (compacted === entry) {
      if (next) {
        next[key] = entry;
      }
      continue;
    }
    next ??= { ...store };
    next[key] = compacted;
  }
  return next ?? store;
}

export function serializeSessionStoreForPersistence(store: Record<string, SessionEntry>): string {
  return JSON.stringify(compactSessionStoreForPersistence(store), null, 2);
}
