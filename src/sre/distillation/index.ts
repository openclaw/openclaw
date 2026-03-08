import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  createIncidentDossierIndex,
  type IncidentDossierIndex,
  type IncidentDossierTimelineEntry,
} from "../contracts/incident-dossier.js";
import { logSreMetric } from "../observability/log.js";
import { resolveSreStatePaths } from "../state/paths.js";

const RUNTIME_DISTILLATION_VERSION = "sre.runtime-distillation.v1";

export type DistilledSummarySections = {
  decisions: string[];
  openTodos: string[];
  constraints: string[];
  pendingAsks: string[];
  identifiers: string[];
};

export type DistillationWriteResult = {
  dossierPath?: string;
  memoryNotePath?: string;
};

type SessionContext = {
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  sessionId?: string;
  workspaceDir?: string;
};

type CompactionDistillationInput = SessionContext & {
  summary: string;
};

type SubagentDistillationInput = {
  childSessionKey: string;
  requesterSessionKey?: string;
  runId?: string;
  reason: string;
  outcome?: string;
  error?: string;
};

function stableHash(parts: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u001f");
  }
  return hash.digest("hex").slice(0, 12);
}

function trimLine(value: string): string {
  return value.replace(/^[-*]\s*/, "").trim();
}

function collectSectionLines(summary: string, heading: string): string[] {
  const lines = summary.split("\n");
  const target = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === target);
  if (start === -1) {
    return [];
  }
  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("## ")) {
      break;
    }
    if (!line) {
      continue;
    }
    collected.push(trimLine(line));
  }
  return collected.filter(Boolean);
}

export function extractDistilledSummarySections(summary: string): DistilledSummarySections {
  return {
    decisions: collectSectionLines(summary, "Decisions"),
    openTodos: collectSectionLines(summary, "Open TODOs"),
    constraints: collectSectionLines(summary, "Constraints/Rules"),
    pendingAsks: collectSectionLines(summary, "Pending user asks"),
    identifiers: collectSectionLines(summary, "Exact identifiers"),
  };
}

function hasDurableSections(sections: DistilledSummarySections): boolean {
  return (
    sections.decisions.length > 0 ||
    sections.openTodos.length > 0 ||
    sections.constraints.length > 0 ||
    sections.pendingAsks.length > 0
  );
}

function findSessionEntryBySessionFile(
  store: Record<string, SessionEntry>,
  sessionFile?: string,
): SessionEntry | undefined {
  if (!sessionFile) {
    return undefined;
  }
  const resolved = path.resolve(sessionFile);
  return Object.values(store).find((entry) => {
    const candidate = entry.sessionFile?.trim();
    return candidate ? path.resolve(candidate) === resolved : false;
  });
}

function findSessionEntryByKey(
  store: Record<string, SessionEntry>,
  sessionKey?: string,
): SessionEntry | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return store[sessionKey];
}

async function readDossierIndex(filePath: string): Promise<IncidentDossierIndex | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as IncidentDossierIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function resolveSessionEntryFromFile(params: {
  sessionFile?: string;
  sessionId?: string;
}): Promise<SessionEntry | undefined> {
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return undefined;
  }
  const storePath = path.join(path.dirname(sessionFile), "sessions.json");
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    return (
      findSessionEntryBySessionFile(store, sessionFile) ??
      Object.values(store).find((entry) => entry.sessionId === params.sessionId)
    );
  } catch {
    return undefined;
  }
}

function buildDossierTimelineEntry(params: {
  at: string;
  refId: string;
  summary: string;
}): IncidentDossierTimelineEntry {
  return {
    at: params.at,
    kind: "note",
    refId: params.refId,
    summary: params.summary,
  };
}

function buildMemoryNote(params: {
  title: string;
  incidentId?: string;
  sections: DistilledSummarySections;
}): string {
  const lines = [`# ${params.title}`];
  if (params.incidentId) {
    lines.push(`incident: ${params.incidentId}`);
  }
  const pushSection = (heading: string, values: string[]) => {
    if (values.length === 0) {
      return;
    }
    lines.push("", `## ${heading}`);
    for (const value of values) {
      lines.push(`- ${value}`);
    }
  };
  pushSection("Decisions", params.sections.decisions);
  pushSection("Open TODOs", params.sections.openTodos);
  pushSection("Constraints", params.sections.constraints);
  pushSection("Pending asks", params.sections.pendingAsks);
  pushSection("Identifiers", params.sections.identifiers);
  return `${lines.join("\n").trim()}\n`;
}

async function writeRuntimeDossierArtifact(params: {
  incidentId: string;
  sessionEntry: SessionEntry | undefined;
  summary: string;
  sections: DistilledSummarySections;
}): Promise<string> {
  const paths = resolveSreStatePaths(process.env);
  const dossierDir = path.join(paths.dossiersDir, params.incidentId);
  await fs.mkdir(dossierDir, { recursive: true });
  const updatedAt = new Date().toISOString();
  const artifactPath = path.join(dossierDir, "runtime-distillation.json");
  const artifact = {
    version: RUNTIME_DISTILLATION_VERSION,
    updatedAt,
    incidentId: params.incidentId,
    sessionKey: params.sessionEntry?.sessionFile ?? undefined,
    sections: params.sections,
    summary: params.summary,
  };
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const indexPath = path.join(dossierDir, "index.json");
  const existingIndex = await readDossierIndex(indexPath);
  const timeline = [
    buildDossierTimelineEntry({
      at: updatedAt,
      refId: `runtime-distillation:${stableHash([params.incidentId, updatedAt])}`,
      summary:
        params.sections.decisions[0] ?? params.sections.pendingAsks[0] ?? "runtime distillation",
    }),
  ];
  const index = createIncidentDossierIndex({
    incidentId: params.incidentId,
    title: existingIndex?.title ?? params.incidentId,
    status: existingIndex?.status ?? "open",
    updatedAt,
    provenance: existingIndex?.provenance ?? [],
    entityIds: [...(existingIndex?.entityIds ?? []), ...(params.sessionEntry?.entityRefs ?? [])],
    bundleIds: existingIndex?.bundleIds ?? [],
    planIds: existingIndex?.planIds ?? [],
    timeline: [...(existingIndex?.timeline ?? []), ...timeline],
  });
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  logSreMetric("distillation_dossier_write", {
    incidentId: params.incidentId,
    path: artifactPath,
  });
  return artifactPath;
}

async function writeMemoryNote(params: {
  workspaceDir?: string;
  incidentId?: string;
  sections: DistilledSummarySections;
  title: string;
}): Promise<string | undefined> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir || !hasDurableSections(params.sections)) {
    return undefined;
  }
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const slug = stableHash([
    params.title,
    params.incidentId ?? "no-incident",
    ...params.sections.decisions,
    ...params.sections.openTodos,
  ]);
  const filePath = path.join(memoryDir, `${date}-runtime-distill-${slug}.md`);
  await fs.writeFile(
    filePath,
    buildMemoryNote({
      title: params.title,
      incidentId: params.incidentId,
      sections: params.sections,
    }),
    "utf8",
  );
  logSreMetric("distillation_memory_note_write", {
    incidentId: params.incidentId,
    path: filePath,
  });
  return filePath;
}

export async function distillCompactionSummary(
  input: CompactionDistillationInput,
): Promise<DistillationWriteResult> {
  const sections = extractDistilledSummarySections(input.summary);
  if (!hasDurableSections(sections) && sections.identifiers.length === 0) {
    return {};
  }
  const sessionEntry =
    input.sessionEntry ??
    (await resolveSessionEntryFromFile({
      sessionFile: input.sessionFile,
      sessionId: input.sessionId,
    }));
  const incidentId = sessionEntry?.incidentId;
  const workspaceDir =
    input.workspaceDir?.trim() ??
    path.dirname(path.dirname(input.sessionFile ?? "")) ??
    path.join(resolveStateDir(process.env, os.homedir), "workspace");

  return {
    dossierPath: incidentId
      ? await writeRuntimeDossierArtifact({
          incidentId,
          sessionEntry,
          summary: input.summary,
          sections,
        })
      : undefined,
    memoryNotePath: await writeMemoryNote({
      workspaceDir,
      incidentId,
      sections,
      title: "Runtime distillation",
    }),
  };
}

export async function distillSubagentOutcome(
  input: SubagentDistillationInput,
): Promise<DistillationWriteResult> {
  const agentId = input.requesterSessionKey?.split(":")[1] ?? undefined;
  const storePath = resolveDefaultSessionStorePath(agentId);
  let sessionEntry: SessionEntry | undefined;
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    sessionEntry =
      findSessionEntryByKey(store, input.requesterSessionKey) ??
      findSessionEntryByKey(store, input.childSessionKey);
  } catch {
    sessionEntry = undefined;
  }
  const sections: DistilledSummarySections = {
    decisions: [],
    openTodos:
      input.outcome && input.outcome !== "ok"
        ? [`Follow up subagent ${input.runId ?? input.childSessionKey}: ${input.outcome}`]
        : [],
    constraints: [],
    pendingAsks: [
      `Subagent ${input.childSessionKey} ended: ${input.reason}${
        input.error ? ` (${input.error})` : ""
      }`,
    ],
    identifiers: [input.runId ?? input.childSessionKey],
  };
  return {
    dossierPath: sessionEntry?.incidentId
      ? await writeRuntimeDossierArtifact({
          incidentId: sessionEntry.incidentId,
          sessionEntry,
          summary: sections.pendingAsks[0] ?? "subagent completion",
          sections,
        })
      : undefined,
    memoryNotePath:
      input.outcome && input.outcome !== "ok"
        ? await writeMemoryNote({
            workspaceDir: undefined,
            incidentId: sessionEntry?.incidentId,
            sections,
            title: "Subagent outcome",
          })
        : undefined,
  };
}
