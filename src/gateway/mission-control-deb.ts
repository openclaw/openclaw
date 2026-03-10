import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

export type MissionControlDebPriority = "p0" | "p1" | "p2" | "p3";
export type MissionControlDebTaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type MissionControlDebUiPriority = "P0" | "P1" | "P2" | "P3";
export type MissionControlDebUiTaskStatus = "todo" | "in-progress" | "blocked" | "done";

export type MissionControlDebProfileSnapshot = {
  name: string;
  role: string;
  photoPath: string | null;
  photoUrl: string | null;
  emails: string[];
  lastUpdated: number;
  storage: "json-file";
  limitations: readonly string[];
};

export type MissionControlDebSprintSnapshot = {
  sprint: {
    id: string;
    name: string;
    goal: string;
    startsOn: string | null;
    endsOn: string | null;
  };
  statusMetrics: {
    total: number;
    todo: number;
    inProgress: number;
    blocked: number;
    done: number;
    completionRate: number;
  };
  lastUpdated: number;
  storage: "json-file";
  limitations: readonly string[];
};

export type MissionControlDebBacklogItem = {
  id: string;
  title: string;
  description: string | null;
  section: string;
  priority: MissionControlDebPriority;
  status: MissionControlDebTaskStatus;
  owner: string;
  notes: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};

export type MissionControlDebBacklogSnapshot = {
  sections: Array<{
    section: string;
    items: MissionControlDebBacklogItem[];
  }>;
  priorities: Record<MissionControlDebPriority, number>;
  statusCounters: Record<MissionControlDebTaskStatus, number>;
  totalItems: number;
  lastUpdated: number;
  storage: "json-file";
  limitations: readonly string[];
};

export type MissionControlDebEmailRecipient = {
  id: string;
  label: string;
  email: string;
  purpose: string;
};

export type MissionControlDebBacklogCompatItem = {
  id: string;
  title: string;
  section: string;
  priority: MissionControlDebUiPriority;
  status: MissionControlDebUiTaskStatus;
  owner: string;
  notes: string;
  updatedAt: number;
};

export type MissionControlDebWorkspaceSnapshot = {
  profile: {
    name: string;
    codename: string;
    role: string;
    bio: string;
    avatarCandidates: string[];
  };
  emails: MissionControlDebEmailRecipient[];
  sprint: {
    sprintLabel: string;
    status: "on-track" | "at-risk" | "blocked";
    focus: string;
    blockers: string[];
    completedCount: number;
    remainingCount: number;
    updatedAt: number;
  };
  backlog: MissionControlDebBacklogCompatItem[];
};

export type MissionControlDebCallAck = {
  ackId: string;
  status: "queued";
  action: string;
  requestedBy: string;
  queuedAt: number;
  queueDepth: number;
  note: string;
  ok: boolean;
  message: string;
  calledAt: number;
  runId: string | null;
  storage: "json-file";
  limitations: readonly string[];
};

type MissionControlDebProfileState = {
  name: string;
  role: string;
  photoPath: string | null;
  photoUrl: string | null;
  emails: string[];
  lastUpdated: number;
};

type MissionControlDebSprintState = {
  id: string;
  name: string;
  goal: string;
  startsOn: string | null;
  endsOn: string | null;
  lastUpdated: number;
};

type MissionControlDebEmailRecipientState = MissionControlDebEmailRecipient & {
  createdAt: number;
  updatedAt: number;
};

type MissionControlDebCallState = {
  ackId: string;
  action: string;
  requestedBy: string;
  queuedAt: number;
  metadata: Record<string, string | number | boolean | null>;
};

type MissionControlDebState = {
  version: 2;
  profile: MissionControlDebProfileState;
  sprint: MissionControlDebSprintState;
  emails: MissionControlDebEmailRecipientState[];
  backlog: MissionControlDebBacklogItem[];
  callQueue: MissionControlDebCallState[];
  lastUpdated: number;
};

const STORAGE = "json-file" as const;
const STORE_RELATIVE_PATH = path.join("mission-control", "deb-store.json");
const CALL_QUEUE_LIMIT = 200;
const VALID_PRIORITIES: ReadonlySet<MissionControlDebPriority> = new Set(["p0", "p1", "p2", "p3"]);
const VALID_STATUSES: ReadonlySet<MissionControlDebTaskStatus> = new Set([
  "todo",
  "in_progress",
  "blocked",
  "done",
]);
const SECTION_ORDER = ["now", "in-progress", "blocked", "next", "later", "done", "inbox"] as const;
const DEFAULT_DEB_AVATARS = [
  "/mission-control/deb/deb-wave.png",
  "/mission-control/deb/deb-reports.png",
  "/mission-control/deb/deb-laptop.png",
  "/skills/deb/images/deb-wave.png",
] as const;
const STORAGE_LIMITATIONS = [
  "MVP persistence is a process-local JSON file scoped to Mission Control.",
  "No multi-writer locking: concurrent writes from multiple gateway processes may race.",
  "Call actions are acknowledgements only; no outbound side effects are executed in pass 2.",
] as const;

function canonicalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function parsePriorityToken(value: unknown): MissionControlDebPriority | null {
  const raw = asString(value);
  if (!raw) {
    return null;
  }
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, "");
  switch (normalized) {
    case "p0":
    case "0":
      return "p0";
    case "p1":
    case "1":
      return "p1";
    case "p2":
    case "2":
      return "p2";
    case "p3":
    case "3":
      return "p3";
    default:
      return null;
  }
}

function parseStatusToken(value: unknown): MissionControlDebTaskStatus | null {
  const raw = asString(value);
  if (!raw) {
    return null;
  }

  const normalized = canonicalizeToken(raw);

  switch (normalized) {
    case "todo":
    case "to do":
    case "backlog":
    case "ready":
      return "todo";
    case "in progress":
    case "in review":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "done":
    case "complete":
    case "completed":
      return "done";
    default:
      return null;
  }
}

const priorityInputSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    const normalized = parsePriorityToken(value);
    if (!normalized) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Priority must map to one of: P0, P1, P2, P3.",
      });
      return z.NEVER;
    }
    return normalized;
  });

const statusInputSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    const normalized = parseStatusToken(value);
    if (!normalized) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Status must map to one of: todo, in-progress, blocked, done, Backlog, Ready, In progress, In review.",
      });
      return z.NEVER;
    }
    return normalized;
  });

const profileUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.string().trim().min(1).max(160).optional(),
    photoPath: z.string().trim().min(1).max(512).nullable().optional(),
    photoUrl: z.string().trim().url().max(1024).nullable().optional(),
    emails: z.array(z.string().trim().email().max(320)).max(25).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one profile field is required.",
  });

const backlogCreateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).nullable().optional(),
  section: z.string().trim().min(1).max(120).optional(),
  priority: priorityInputSchema.optional(),
  status: statusInputSchema.optional(),
  owner: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

const backlogPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    section: z.string().trim().min(1).max(120).optional(),
    priority: priorityInputSchema.optional(),
    status: statusInputSchema.optional(),
    owner: z.string().trim().min(1).max(120).optional(),
    notes: z.string().trim().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one backlog field is required.",
  });

const callRequestSchema = z
  .object({
    action: z.string().trim().min(1).max(120).optional(),
    instruction: z.string().trim().min(1).max(2000).optional(),
    requestedBy: z.string().trim().min(1).max(120).optional(),
    metadata: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .superRefine((value, context) => {
    if (!value.action && !value.instruction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either action or instruction is required.",
        path: ["action"],
      });
    }
  })
  .transform((value) => ({
    action: value.action ?? value.instruction ?? "call-deb",
    instruction: value.instruction ?? value.action ?? "",
    requestedBy: value.requestedBy,
    metadata: value.metadata,
  }));

const emailDraftSchema = z.object({
  label: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  purpose: z.string().trim().min(1).max(240),
});

const emailReplaceEntrySchema = emailDraftSchema.extend({
  id: z.string().trim().min(1).max(160).optional(),
});

const emailReplaceSchema = z
  .union([
    z.array(emailReplaceEntrySchema).max(50),
    z.object({ emails: z.array(emailReplaceEntrySchema).max(50) }),
    z.object({ recipients: z.array(emailReplaceEntrySchema).max(50) }),
  ])
  .transform((value) => {
    if (Array.isArray(value)) {
      return { emails: value };
    }
    if ("emails" in value) {
      return { emails: value.emails };
    }
    return { emails: value.recipients };
  });

export type MissionControlDebProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
export type MissionControlDebBacklogCreateInput = z.infer<typeof backlogCreateSchema>;
export type MissionControlDebBacklogPatchInput = z.infer<typeof backlogPatchSchema>;
export type MissionControlDebCallInput = z.infer<typeof callRequestSchema>;
export type MissionControlDebEmailDraftInput = z.infer<typeof emailDraftSchema>;
export type MissionControlDebEmailReplaceInput = z.infer<typeof emailReplaceSchema>;

let cachedState: MissionControlDebState | null = null;
let cachedStorePath: string | null = null;

function now(): number {
  return Date.now();
}

function resolveStorePath(): string {
  return path.join(resolveStateDir(), STORE_RELATIVE_PATH);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
}

function normalizePriority(value: unknown): MissionControlDebPriority {
  const candidate = parsePriorityToken(value);
  if (candidate && VALID_PRIORITIES.has(candidate)) {
    return candidate;
  }
  return "p2";
}

function normalizeStatus(value: unknown): MissionControlDebTaskStatus {
  const candidate = parseStatusToken(value);
  if (candidate && VALID_STATUSES.has(candidate)) {
    return candidate;
  }
  return "todo";
}

function toUiPriority(priority: MissionControlDebPriority): MissionControlDebUiPriority {
  return priority.toUpperCase() as MissionControlDebUiPriority;
}

function toUiStatus(status: MissionControlDebTaskStatus): MissionControlDebUiTaskStatus {
  if (status === "in_progress") {
    return "in-progress";
  }
  return status;
}

function sanitizeSection(value: unknown): string {
  return asString(value)?.toLowerCase() ?? "inbox";
}

function buildDefaultEmailRecipient(params: {
  email: string;
  fallbackTime: number;
  id?: string;
  label?: string;
  purpose?: string;
}): MissionControlDebEmailRecipientState {
  const localPart = params.email.split("@")[0] ?? "deb";
  return {
    id: params.id ?? `deb-email-${randomUUID()}`,
    label:
      params.label ??
      localPart.replace(/[._-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
    email: params.email.toLowerCase(),
    purpose: params.purpose ?? "Deb workflow notifications",
    createdAt: params.fallbackTime,
    updatedAt: params.fallbackTime,
  };
}

function normalizeEmailRecipient(
  raw: unknown,
  fallbackTime: number,
): MissionControlDebEmailRecipientState | null {
  if (typeof raw === "string") {
    const email = asString(raw)?.toLowerCase();
    if (!email) {
      return null;
    }
    return buildDefaultEmailRecipient({
      email,
      fallbackTime,
    });
  }

  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const email = asString(record.email)?.toLowerCase();
  if (!email) {
    return null;
  }

  return {
    id: asString(record.id) ?? `deb-email-${randomUUID()}`,
    label: asString(record.label) ?? buildDefaultEmailRecipient({ email, fallbackTime }).label,
    email,
    purpose: asString(record.purpose) ?? "Deb workflow notifications",
    createdAt: asNumber(record.createdAt) ?? fallbackTime,
    updatedAt: asNumber(record.updatedAt) ?? fallbackTime,
  };
}

function normalizeEmailRecipients(
  raw: unknown,
  fallbackEmails: string[],
  fallbackTime: number,
): MissionControlDebEmailRecipientState[] {
  const source: unknown[] = Array.isArray(raw)
    ? raw
    : fallbackEmails.map((email) => ({
        email,
      }));

  const deduped = new Map<string, MissionControlDebEmailRecipientState>();
  for (const entry of source) {
    const normalized = normalizeEmailRecipient(entry, fallbackTime);
    if (!normalized) {
      continue;
    }
    const key = normalized.email.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }

  return [...deduped.values()];
}

function normalizeBacklogItem(raw: unknown): MissionControlDebBacklogItem | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const id = asString(record.id);
  const title = asString(record.title);
  if (!id || !title) {
    return null;
  }

  const createdAt = asNumber(record.createdAt) ?? now();
  const updatedAt = asNumber(record.updatedAt) ?? createdAt;
  const tags = Array.from(new Set(asStringArray(record.tags).map((tag) => tag.toLowerCase())));
  const description = record.description === null ? null : asString(record.description);
  const notes = asString(record.notes) ?? description ?? "";

  return {
    id,
    title,
    description,
    section: sanitizeSection(record.section),
    priority: normalizePriority(record.priority),
    status: normalizeStatus(record.status),
    owner: asString(record.owner) ?? "Deb",
    notes,
    tags,
    createdAt,
    updatedAt,
  };
}

function normalizeProfile(raw: unknown, fallbackTime: number): MissionControlDebProfileState {
  const record = asRecord(raw);
  const emails = Array.from(
    new Set(asStringArray(record?.emails).map((entry) => entry.toLowerCase())),
  );
  return {
    name: asString(record?.name) ?? "Deb",
    role: asString(record?.role) ?? "Project Board Operator",
    photoPath: record?.photoPath === null ? null : asString(record?.photoPath),
    photoUrl: record?.photoUrl === null ? null : asString(record?.photoUrl),
    emails,
    lastUpdated: asNumber(record?.lastUpdated) ?? fallbackTime,
  };
}

function normalizeSprint(raw: unknown, fallbackTime: number): MissionControlDebSprintState {
  const record = asRecord(raw);
  return {
    id: asString(record?.id) ?? "current",
    name: asString(record?.name) ?? "Current Sprint",
    goal: asString(record?.goal) ?? "Drive full-visibility task operations for Mission Control",
    startsOn: record?.startsOn === null ? null : asString(record?.startsOn),
    endsOn: record?.endsOn === null ? null : asString(record?.endsOn),
    lastUpdated: asNumber(record?.lastUpdated) ?? fallbackTime,
  };
}

function normalizeCallQueue(raw: unknown): MissionControlDebCallState[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const queue: MissionControlDebCallState[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const ackId = asString(record.ackId);
    const action = asString(record.action);
    const requestedBy = asString(record.requestedBy) ?? "unknown";
    const queuedAt = asNumber(record.queuedAt) ?? now();
    if (!ackId || !action) {
      continue;
    }

    const rawMetadata = asRecord(record.metadata) ?? {};
    const metadata: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(rawMetadata)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        metadata[key] = value;
      }
    }

    queue.push({
      ackId,
      action,
      requestedBy,
      queuedAt,
      metadata,
    });
  }

  if (queue.length <= CALL_QUEUE_LIMIT) {
    return queue;
  }
  return queue.slice(queue.length - CALL_QUEUE_LIMIT);
}

function normalizeState(raw: unknown): MissionControlDebState {
  const timestamp = now();
  const record = asRecord(raw);

  const profile = normalizeProfile(record?.profile, timestamp);
  const backlogRaw = Array.isArray(record?.backlog) ? record.backlog : [];
  const backlog = backlogRaw
    .map((item) => normalizeBacklogItem(item))
    .filter((item): item is MissionControlDebBacklogItem => item !== null);

  const emailSeed = record?.emails ?? record?.emailRecipients ?? profile.emails;
  const emails = normalizeEmailRecipients(emailSeed, profile.emails, profile.lastUpdated);

  const state: MissionControlDebState = {
    version: 2,
    profile: {
      ...profile,
      emails: emails.map((entry) => entry.email),
    },
    sprint: normalizeSprint(record?.sprint, timestamp),
    emails,
    backlog,
    callQueue: normalizeCallQueue(record?.callQueue),
    lastUpdated: asNumber(record?.lastUpdated) ?? timestamp,
  };

  return state;
}

function loadState(): MissionControlDebState {
  const storePath = resolveStorePath();
  if (cachedState && cachedStorePath === storePath) {
    return cachedState;
  }
  const raw = loadJsonFile(storePath);
  const nextState = normalizeState(raw);
  cachedState = nextState;
  cachedStorePath = storePath;
  return nextState;
}

function persistState(state: MissionControlDebState): MissionControlDebState {
  const storePath = resolveStorePath();
  saveJsonFile(storePath, state);
  cachedState = state;
  cachedStorePath = storePath;
  return state;
}

function buildStatusCounters(
  backlog: readonly MissionControlDebBacklogItem[],
): Record<MissionControlDebTaskStatus, number> {
  const counters: Record<MissionControlDebTaskStatus, number> = {
    todo: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  };

  for (const item of backlog) {
    counters[item.status] += 1;
  }

  return counters;
}

function buildPriorityCounters(
  backlog: readonly MissionControlDebBacklogItem[],
): Record<MissionControlDebPriority, number> {
  const counters: Record<MissionControlDebPriority, number> = {
    p0: 0,
    p1: 0,
    p2: 0,
    p3: 0,
  };

  for (const item of backlog) {
    counters[item.priority] += 1;
  }

  return counters;
}

function sectionSortKey(section: string): number {
  const index = SECTION_ORDER.indexOf(section as (typeof SECTION_ORDER)[number]);
  return index === -1 ? SECTION_ORDER.length + 1 : index;
}

function groupBacklogBySection(
  backlog: readonly MissionControlDebBacklogItem[],
): MissionControlDebBacklogSnapshot["sections"] {
  const grouped = new Map<string, MissionControlDebBacklogItem[]>();

  for (const item of backlog) {
    const section = sanitizeSection(item.section);
    const list = grouped.get(section) ?? [];
    list.push(item);
    grouped.set(section, list);
  }

  return Array.from(grouped.entries())
    .map(([section, items]) => ({
      section,
      items: [...items].toSorted((left, right) => right.updatedAt - left.updatedAt),
    }))
    .toSorted((left, right) => {
      const byKnownOrder = sectionSortKey(left.section) - sectionSortKey(right.section);
      if (byKnownOrder !== 0) {
        return byKnownOrder;
      }
      return left.section.localeCompare(right.section);
    });
}

function computeBacklogLastUpdated(
  backlog: readonly MissionControlDebBacklogItem[],
  fallback: number,
): number {
  const latest = backlog.reduce((max, item) => Math.max(max, item.updatedAt), 0);
  return latest > 0 ? latest : fallback;
}

function snapshotProfile(state: MissionControlDebState): MissionControlDebProfileSnapshot {
  return {
    name: state.profile.name,
    role: state.profile.role,
    photoPath: state.profile.photoPath,
    photoUrl: state.profile.photoUrl,
    emails: [...state.profile.emails],
    lastUpdated: state.profile.lastUpdated,
    storage: STORAGE,
    limitations: STORAGE_LIMITATIONS,
  };
}

function snapshotEmails(state: MissionControlDebState): MissionControlDebEmailRecipient[] {
  return state.emails.map((entry) => ({
    id: entry.id,
    label: entry.label,
    email: entry.email,
    purpose: entry.purpose,
  }));
}

function toCompatBacklogItem(
  item: MissionControlDebBacklogItem,
): MissionControlDebBacklogCompatItem {
  return {
    id: item.id,
    title: item.title,
    section: item.section,
    priority: toUiPriority(item.priority),
    status: toUiStatus(item.status),
    owner: item.owner,
    notes: item.notes,
    updatedAt: item.updatedAt,
  };
}

function deriveSprintStatus(state: MissionControlDebState): "on-track" | "at-risk" | "blocked" {
  const counters = buildStatusCounters(state.backlog);
  if (counters.blocked > 0) {
    return "blocked";
  }

  const total = state.backlog.length;
  if (total > 0 && counters.in_progress === 0 && counters.done < total) {
    return "at-risk";
  }

  return "on-track";
}

function buildAvatarCandidates(state: MissionControlDebState): string[] {
  const candidates = [state.profile.photoUrl, state.profile.photoPath, ...DEFAULT_DEB_AVATARS]
    .map((candidate) => asString(candidate))
    .filter((candidate): candidate is string => candidate !== null);
  return [...new Set(candidates)];
}

function syncProfileEmailsFromRecipients(
  profile: MissionControlDebProfileState,
  recipients: readonly MissionControlDebEmailRecipientState[],
): MissionControlDebProfileState {
  return {
    ...profile,
    emails: recipients.map((entry) => entry.email),
  };
}

export function parseMissionControlDebProfileUpdateInput(
  payload: unknown,
): MissionControlDebProfileUpdateInput {
  return profileUpdateSchema.parse(payload);
}

export function parseMissionControlDebBacklogCreateInput(
  payload: unknown,
): MissionControlDebBacklogCreateInput {
  return backlogCreateSchema.parse(payload);
}

export function parseMissionControlDebBacklogPatchInput(
  payload: unknown,
): MissionControlDebBacklogPatchInput {
  return backlogPatchSchema.parse(payload);
}

export function parseMissionControlDebCallInput(payload: unknown): MissionControlDebCallInput {
  return callRequestSchema.parse(payload);
}

export function parseMissionControlDebEmailDraftInput(
  payload: unknown,
): MissionControlDebEmailDraftInput {
  return emailDraftSchema.parse(payload);
}

export function parseMissionControlDebEmailReplaceInput(
  payload: unknown,
): MissionControlDebEmailReplaceInput {
  return emailReplaceSchema.parse(payload);
}

export function getMissionControlDebProfile(): MissionControlDebProfileSnapshot {
  return snapshotProfile(loadState());
}

export function updateMissionControlDebProfile(
  input: MissionControlDebProfileUpdateInput,
): MissionControlDebProfileSnapshot {
  const state = loadState();
  const updatedAt = now();

  const nextEmails =
    input.emails === undefined
      ? [...state.emails]
      : input.emails
          .map((entry) => entry.toLowerCase())
          .reduce<MissionControlDebEmailRecipientState[]>((acc, email) => {
            if (acc.some((existing) => existing.email === email)) {
              return acc;
            }
            const existing = state.emails.find((recipient) => recipient.email === email);
            if (existing) {
              acc.push({
                ...existing,
                updatedAt,
              });
              return acc;
            }
            acc.push(
              buildDefaultEmailRecipient({
                email,
                fallbackTime: updatedAt,
              }),
            );
            return acc;
          }, []);

  const profile: MissionControlDebProfileState = {
    name: input.name ?? state.profile.name,
    role: input.role ?? state.profile.role,
    photoPath: input.photoPath === undefined ? state.profile.photoPath : input.photoPath,
    photoUrl: input.photoUrl === undefined ? state.profile.photoUrl : input.photoUrl,
    emails: nextEmails.map((entry) => entry.email),
    lastUpdated: updatedAt,
  };

  const next: MissionControlDebState = {
    ...state,
    profile,
    emails: nextEmails,
    lastUpdated: updatedAt,
  };

  return snapshotProfile(persistState(next));
}

export function getMissionControlDebEmails(): MissionControlDebEmailRecipient[] {
  return snapshotEmails(loadState());
}

export function replaceMissionControlDebEmails(
  input: MissionControlDebEmailReplaceInput,
): MissionControlDebEmailRecipient[] {
  const state = loadState();
  const updatedAt = now();
  const deduped: MissionControlDebEmailRecipientState[] = [];

  for (const emailInput of input.emails) {
    const lowered = emailInput.email.toLowerCase();
    if (deduped.some((entry) => entry.email === lowered)) {
      continue;
    }

    const existingById = emailInput.id
      ? state.emails.find((entry) => entry.id === emailInput.id)
      : undefined;
    const existingByEmail = state.emails.find((entry) => entry.email === lowered);
    const existing = existingById ?? existingByEmail;

    deduped.push({
      id: existing?.id ?? emailInput.id ?? `deb-email-${randomUUID()}`,
      label: emailInput.label,
      email: lowered,
      purpose: emailInput.purpose,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    });
  }

  const next: MissionControlDebState = {
    ...state,
    emails: deduped,
    profile: {
      ...syncProfileEmailsFromRecipients(state.profile, deduped),
      lastUpdated: updatedAt,
    },
    lastUpdated: updatedAt,
  };

  persistState(next);
  return snapshotEmails(next);
}

export function createMissionControlDebEmail(
  input: MissionControlDebEmailDraftInput,
): MissionControlDebEmailRecipient {
  const state = loadState();
  const updatedAt = now();
  const lowered = input.email.toLowerCase();
  const existingIndex = state.emails.findIndex((entry) => entry.email === lowered);

  if (existingIndex >= 0) {
    const updated: MissionControlDebEmailRecipientState = {
      ...state.emails[existingIndex],
      label: input.label,
      purpose: input.purpose,
      updatedAt,
    };

    const emails = [...state.emails];
    emails[existingIndex] = updated;

    const next: MissionControlDebState = {
      ...state,
      emails,
      profile: {
        ...syncProfileEmailsFromRecipients(state.profile, emails),
        lastUpdated: updatedAt,
      },
      lastUpdated: updatedAt,
    };

    persistState(next);
    return {
      id: updated.id,
      label: updated.label,
      email: updated.email,
      purpose: updated.purpose,
    };
  }

  const created = {
    id: `deb-email-${randomUUID()}`,
    label: input.label,
    email: lowered,
    purpose: input.purpose,
    createdAt: updatedAt,
    updatedAt,
  } satisfies MissionControlDebEmailRecipientState;

  const emails = [...state.emails, created];
  const next: MissionControlDebState = {
    ...state,
    emails,
    profile: {
      ...syncProfileEmailsFromRecipients(state.profile, emails),
      lastUpdated: updatedAt,
    },
    lastUpdated: updatedAt,
  };

  persistState(next);
  return {
    id: created.id,
    label: created.label,
    email: created.email,
    purpose: created.purpose,
  };
}

export function updateMissionControlDebEmail(
  emailId: string,
  input: MissionControlDebEmailDraftInput,
): MissionControlDebEmailRecipient | null {
  const state = loadState();
  const index = state.emails.findIndex((entry) => entry.id === emailId);
  if (index < 0) {
    return null;
  }

  const updatedAt = now();
  const lowered = input.email.toLowerCase();

  const updated: MissionControlDebEmailRecipientState = {
    ...state.emails[index],
    label: input.label,
    email: lowered,
    purpose: input.purpose,
    updatedAt,
  };

  const emails = [...state.emails];
  emails[index] = updated;

  const deduped: MissionControlDebEmailRecipientState[] = [];
  for (const entry of emails) {
    if (!deduped.some((existing) => existing.email === entry.email)) {
      deduped.push(entry);
    }
  }

  const next: MissionControlDebState = {
    ...state,
    emails: deduped,
    profile: {
      ...syncProfileEmailsFromRecipients(state.profile, deduped),
      lastUpdated: updatedAt,
    },
    lastUpdated: updatedAt,
  };

  persistState(next);
  return {
    id: updated.id,
    label: updated.label,
    email: updated.email,
    purpose: updated.purpose,
  };
}

export function removeMissionControlDebEmail(emailId: string): boolean {
  const state = loadState();
  const emails = state.emails.filter((entry) => entry.id !== emailId);
  if (emails.length === state.emails.length) {
    return false;
  }

  const updatedAt = now();
  const next: MissionControlDebState = {
    ...state,
    emails,
    profile: {
      ...syncProfileEmailsFromRecipients(state.profile, emails),
      lastUpdated: updatedAt,
    },
    lastUpdated: updatedAt,
  };

  persistState(next);
  return true;
}

export function getMissionControlDebSprint(): MissionControlDebSprintSnapshot {
  const state = loadState();
  const status = buildStatusCounters(state.backlog);
  const total = state.backlog.length;
  const completionRate = total > 0 ? Number((status.done / total).toFixed(4)) : 0;

  return {
    sprint: {
      id: state.sprint.id,
      name: state.sprint.name,
      goal: state.sprint.goal,
      startsOn: state.sprint.startsOn,
      endsOn: state.sprint.endsOn,
    },
    statusMetrics: {
      total,
      todo: status.todo,
      inProgress: status.in_progress,
      blocked: status.blocked,
      done: status.done,
      completionRate,
    },
    lastUpdated: Math.max(
      state.sprint.lastUpdated,
      computeBacklogLastUpdated(state.backlog, state.lastUpdated),
    ),
    storage: STORAGE,
    limitations: STORAGE_LIMITATIONS,
  };
}

export function getMissionControlDebBacklog(): MissionControlDebBacklogSnapshot {
  const state = loadState();
  return {
    sections: groupBacklogBySection(state.backlog),
    priorities: buildPriorityCounters(state.backlog),
    statusCounters: buildStatusCounters(state.backlog),
    totalItems: state.backlog.length,
    lastUpdated: computeBacklogLastUpdated(state.backlog, state.lastUpdated),
    storage: STORAGE,
    limitations: STORAGE_LIMITATIONS,
  };
}

export function getMissionControlDebWorkspace(): MissionControlDebWorkspaceSnapshot {
  const state = loadState();
  const statusCounters = buildStatusCounters(state.backlog);
  const total = state.backlog.length;
  const completedCount = statusCounters.done;

  return {
    profile: {
      name: state.profile.name,
      codename: "Kanban Oracle",
      role: state.profile.role,
      bio: "Keeps backlog state clean, ownership clear, and sprint notes fresh across the board.",
      avatarCandidates: buildAvatarCandidates(state),
    },
    emails: snapshotEmails(state),
    sprint: {
      sprintLabel: state.sprint.name,
      status: deriveSprintStatus(state),
      focus: state.sprint.goal,
      blockers: state.backlog.filter((item) => item.status === "blocked").map((item) => item.title),
      completedCount,
      remainingCount: Math.max(total - completedCount, 0),
      updatedAt: Math.max(
        state.sprint.lastUpdated,
        computeBacklogLastUpdated(state.backlog, state.lastUpdated),
      ),
    },
    backlog: [...state.backlog]
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
      .map((item) => toCompatBacklogItem(item)),
  };
}

export function createMissionControlDebBacklogItem(
  input: MissionControlDebBacklogCreateInput,
): MissionControlDebBacklogItem {
  const state = loadState();
  const timestamp = now();
  const item: MissionControlDebBacklogItem = {
    id: randomUUID(),
    title: input.title,
    description: input.description ?? (input.notes ? input.notes : null),
    section: sanitizeSection(input.section),
    priority: input.priority ?? "p2",
    status: input.status ?? "todo",
    owner: input.owner ?? "Deb",
    notes: input.notes ?? input.description ?? "",
    tags: Array.from(new Set((input.tags ?? []).map((entry) => entry.toLowerCase()))),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const next: MissionControlDebState = {
    ...state,
    backlog: [...state.backlog, item],
    lastUpdated: timestamp,
  };

  persistState(next);
  return item;
}

export function updateMissionControlDebBacklogItem(
  itemId: string,
  input: MissionControlDebBacklogPatchInput,
): MissionControlDebBacklogItem | null {
  const state = loadState();
  const index = state.backlog.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return null;
  }

  const timestamp = now();
  const current = state.backlog[index];
  const updated: MissionControlDebBacklogItem = {
    ...current,
    title: input.title ?? current.title,
    description: input.description === undefined ? current.description : input.description,
    section: input.section === undefined ? current.section : sanitizeSection(input.section),
    priority: input.priority ?? current.priority,
    status: input.status ?? current.status,
    owner: input.owner ?? current.owner,
    notes:
      input.notes === undefined
        ? input.description === undefined
          ? current.notes
          : (input.description ?? "")
        : input.notes,
    tags:
      input.tags === undefined
        ? [...current.tags]
        : Array.from(new Set(input.tags.map((entry) => entry.toLowerCase()))),
    updatedAt: timestamp,
  };

  const backlog = [...state.backlog];
  backlog[index] = updated;

  const next: MissionControlDebState = {
    ...state,
    backlog,
    lastUpdated: timestamp,
  };

  persistState(next);
  return updated;
}

export function createMissionControlDebCall(
  input: MissionControlDebCallInput,
): MissionControlDebCallAck {
  const state = loadState();
  const queuedAt = now();
  const ackId = `deb-call-${randomUUID()}`;

  const metadata: Record<string, string | number | boolean | null> = {
    ...input.metadata,
  };
  if (input.instruction && !metadata.instruction) {
    metadata.instruction = input.instruction;
  }

  const callEntry: MissionControlDebCallState = {
    ackId,
    action: input.action,
    requestedBy: input.requestedBy ?? "mission-control-ui",
    queuedAt,
    metadata,
  };

  const queue = [...state.callQueue, callEntry];
  const trimmedQueue =
    queue.length > CALL_QUEUE_LIMIT ? queue.slice(queue.length - CALL_QUEUE_LIMIT) : queue;

  const next: MissionControlDebState = {
    ...state,
    callQueue: trimmedQueue,
    lastUpdated: queuedAt,
  };

  persistState(next);

  return {
    ackId,
    status: "queued",
    action: callEntry.action,
    requestedBy: callEntry.requestedBy,
    queuedAt,
    queueDepth: trimmedQueue.length,
    note: "Pass 2 queued the Deb call request metadata only. No external actions executed.",
    ok: true,
    message: "Deb call accepted and queued for operator follow-up.",
    calledAt: queuedAt,
    runId: null,
    storage: STORAGE,
    limitations: STORAGE_LIMITATIONS,
  };
}

export function resetMissionControlDebStoreForTests(): void {
  cachedState = null;
  cachedStorePath = null;
}
