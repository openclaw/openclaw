import type {
  SkillsProposalEvaluateResult,
  SkillsProposalInspectResult,
  SkillsProposalRecordResult,
  SkillsProposalsListResult,
} from "@openclaw/gateway-protocol";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { formatBytes } from "../../lib/agents/display.ts";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";

export function parseDateMs(value: string | undefined): number {
  return parseDateStringTimestampMs(value) ?? Date.now();
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function recencyGroup(ms: number): SkillWorkshopProposal["recencyGroup"] {
  const today = startOfLocalDay(Date.now());
  const day = startOfLocalDay(ms);
  if (day === today) {
    return "today";
  }
  if (day === today - 24 * 60 * 60 * 1000) {
    return "yesterday";
  }
  return "earlier";
}

function compactAgeLabel(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) {
    return "now";
  }
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h`;
  }
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function proposedVersionNumber(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? "").replace(/^v/i, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function stripProposalFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function supportFilesFromInspect(
  result: SkillsProposalInspectResult,
): SkillWorkshopProposal["supportFiles"] {
  const sizes = new Map(
    (result.record.supportFiles ?? []).map((file) => [file.path, file.sizeBytes]),
  );
  return (result.supportFiles ?? []).map((file) => ({
    path: file.path,
    size: formatBytes(Math.max(0, sizes.get(file.path) ?? byteLength(file.content)), {
      fallback: "0 B",
      maxUnit: "kilo",
      fractionDigits: (_value, unit) => (unit === "byte" ? null : 1),
    }),
    contents: file.content,
  }));
}

export function proposalFromManifest(
  entry: SkillsProposalsListResult["proposals"][number],
  previous: SkillWorkshopProposal | undefined,
): SkillWorkshopProposal {
  const updatedAt = parseDateMs(entry.updatedAt);
  const createdAt = parseDateMs(entry.createdAt);
  const previousIsCurrent =
    previous?.updatedAt === updatedAt && !entry.degradedState && !previous.degradedState;
  return {
    key: entry.id,
    kind: entry.kind,
    slug: entry.skillKey,
    name: entry.title || entry.skillName,
    oneLine: entry.description,
    body: previousIsCurrent ? previous.body : "",
    bodyLoaded: previousIsCurrent ? previous.bodyLoaded : false,
    status: entry.status,
    degradedState: entry.degradedState,
    ...(previousIsCurrent && previous.origin ? { origin: previous.origin } : {}),
    version: previousIsCurrent ? previous.version : 1,
    // A missing draft can still be rejected against its recorded revision.
    // Usable drafts require inspection before a decision can capture their hash.
    revisionHash: entry.degradedState
      ? (entry.revisionHash ?? null)
      : previousIsCurrent
        ? previous.revisionHash
        : null,
    ...(previousIsCurrent && previous.evaluation ? { evaluation: previous.evaluation } : {}),
    createdAt,
    updatedAt,
    recencyGroup: recencyGroup(updatedAt || createdAt),
    ageLabel: compactAgeLabel(updatedAt || createdAt),
    supportFiles: previousIsCurrent ? previous.supportFiles : [],
  };
}

function proposalBaseFromRecord(record: SkillsProposalRecordResult) {
  const updatedAt = parseDateMs(record.updatedAt);
  const createdAt = parseDateMs(record.createdAt);
  return {
    key: record.id,
    kind: record.kind,
    slug: record.target.skillKey,
    name: record.title || record.target.skillName,
    oneLine: record.description,
    status: record.status,
    version: proposedVersionNumber(record.proposedVersion),
    createdAt,
    updatedAt,
    recencyGroup: recencyGroup(updatedAt || createdAt),
    ageLabel: compactAgeLabel(updatedAt || createdAt),
  };
}

export function proposalFromInspect(
  result: SkillsProposalInspectResult,
  previous: SkillWorkshopProposal | undefined,
): SkillWorkshopProposal {
  const record = result.record;
  const revisionHash = result.revisionHash?.trim() || null;
  const evaluation =
    record.evaluation?.revisionHash === revisionHash
      ? record.evaluation
      : previous?.evaluation?.revisionHash === revisionHash
        ? previous.evaluation
        : undefined;
  return {
    ...proposalBaseFromRecord(record),
    body: stripProposalFrontmatter(result.content),
    bodyLoaded: true,
    ...(record.origin ? { origin: record.origin } : {}),
    revisionHash,
    ...(evaluation ? { evaluation } : {}),
    supportFiles: supportFilesFromInspect(result),
  };
}

export function proposalFromEvaluation(
  result: SkillsProposalEvaluateResult,
  previous: SkillWorkshopProposal,
): SkillWorkshopProposal {
  const record = result.record;
  return {
    ...proposalBaseFromRecord(record),
    body: previous.body,
    bodyLoaded: previous.bodyLoaded,
    ...(record.origin
      ? { origin: record.origin }
      : previous.origin
        ? { origin: previous.origin }
        : {}),
    revisionHash: result.evaluation.revisionHash,
    evaluation: result.evaluation,
    supportFiles: previous.supportFiles,
  };
}

// Terminal actions keep the reviewed draft; the record owns lifecycle metadata.
export function proposalFromActionRecord(
  record: SkillsProposalRecordResult,
  previous: SkillWorkshopProposal | undefined,
): SkillWorkshopProposal {
  return {
    ...proposalBaseFromRecord(record),
    body: previous?.body ?? "",
    bodyLoaded: previous?.bodyLoaded ?? false,
    ...(record.origin
      ? { origin: record.origin }
      : previous?.origin
        ? { origin: previous.origin }
        : {}),
    revisionHash: previous?.revisionHash ?? null,
    ...(record.evaluation
      ? { evaluation: record.evaluation }
      : previous?.evaluation
        ? { evaluation: previous.evaluation }
        : {}),
    supportFiles: previous?.supportFiles ?? [],
    degradedState: previous?.degradedState,
  };
}
