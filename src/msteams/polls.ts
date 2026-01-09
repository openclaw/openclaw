import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { resolveMSTeamsStorePath } from "./storage.js";

export type MSTeamsPollVote = {
  pollId: string;
  selections: string[];
};

export type MSTeamsPoll = {
  id: string;
  question: string;
  options: string[];
  maxSelections: number;
  createdAt: string;
  updatedAt?: string;
  conversationId?: string;
  messageId?: string;
  votes: Record<string, string[]>;
};

export type MSTeamsPollStore = {
  createPoll: (poll: MSTeamsPoll) => Promise<void>;
  getPoll: (pollId: string) => Promise<MSTeamsPoll | null>;
  recordVote: (params: {
    pollId: string;
    voterId: string;
    selections: string[];
  }) => Promise<MSTeamsPoll | null>;
};

export type MSTeamsPollCard = {
  pollId: string;
  question: string;
  options: string[];
  maxSelections: number;
  card: Record<string, unknown>;
  fallbackText: string;
};

type PollStoreData = {
  version: 1;
  polls: Record<string, MSTeamsPoll>;
};

const STORE_FILENAME = "msteams-polls.json";
const MAX_POLLS = 1000;
const POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeChoiceValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function extractSelections(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(normalizeChoiceValue)
      .filter((entry): entry is string => Boolean(entry));
  }
  const normalized = normalizeChoiceValue(value);
  if (!normalized) return [];
  if (normalized.includes(",")) {
    return normalized
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [normalized];
}

function readNestedValue(
  value: unknown,
  keys: Array<string | number>,
): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key as keyof typeof current];
  }
  return current;
}

function readNestedString(
  value: unknown,
  keys: Array<string | number>,
): string | undefined {
  const found = readNestedValue(value, keys);
  return typeof found === "string" && found.trim() ? found.trim() : undefined;
}

export function extractMSTeamsPollVote(
  activity: { value?: unknown } | undefined,
): MSTeamsPollVote | null {
  const value = activity?.value;
  if (!value || !isRecord(value)) return null;
  const pollId =
    readNestedString(value, ["clawdbotPollId"]) ??
    readNestedString(value, ["pollId"]) ??
    readNestedString(value, ["clawdbot", "pollId"]) ??
    readNestedString(value, ["clawdbot", "poll", "id"]) ??
    readNestedString(value, ["data", "clawdbotPollId"]) ??
    readNestedString(value, ["data", "pollId"]) ??
    readNestedString(value, ["data", "clawdbot", "pollId"]);
  if (!pollId) return null;

  const directSelections = extractSelections(value.choices);
  const nestedSelections = extractSelections(
    readNestedValue(value, ["choices"]),
  );
  const dataSelections = extractSelections(
    readNestedValue(value, ["data", "choices"]),
  );
  const selections =
    directSelections.length > 0
      ? directSelections
      : nestedSelections.length > 0
        ? nestedSelections
        : dataSelections;

  if (selections.length === 0) return null;

  return {
    pollId,
    selections,
  };
}

export function buildMSTeamsPollCard(params: {
  question: string;
  options: string[];
  maxSelections?: number;
  pollId?: string;
}): MSTeamsPollCard {
  const pollId = params.pollId ?? crypto.randomUUID();
  const maxSelections =
    typeof params.maxSelections === "number" && params.maxSelections > 1
      ? Math.floor(params.maxSelections)
      : 1;
  const cappedMaxSelections = Math.min(
    Math.max(1, maxSelections),
    params.options.length,
  );
  const choices = params.options.map((option, index) => ({
    title: option,
    value: String(index),
  }));
  const hint =
    cappedMaxSelections > 1
      ? `Select up to ${cappedMaxSelections} option${cappedMaxSelections === 1 ? "" : "s"}.`
      : "Select one option.";

  const card = {
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: params.question,
        wrap: true,
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "Input.ChoiceSet",
        id: "choices",
        isMultiSelect: cappedMaxSelections > 1,
        style: "expanded",
        choices,
      },
      {
        type: "TextBlock",
        text: hint,
        wrap: true,
        isSubtle: true,
        spacing: "Small",
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Vote",
        data: {
          clawdbotPollId: pollId,
        },
        msteams: {
          type: "messageBack",
          text: "clawdbot poll vote",
          displayText: "Vote recorded",
          value: { clawdbotPollId: pollId },
        },
      },
    ],
  };

  const fallbackLines = [
    `Poll: ${params.question}`,
    ...params.options.map((option, index) => `${index + 1}. ${option}`),
  ];

  return {
    pollId,
    question: params.question,
    options: params.options,
    maxSelections: cappedMaxSelections,
    card,
    fallbackText: fallbackLines.join("\n"),
  };
}

export type MSTeamsPollStoreFsOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
};

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = safeParseJson<T>(raw);
    if (parsed == null) return { value: fallback, exists: true };
    return { value: parsed, exists: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return { value: fallback, exists: false };
    return { value: fallback, exists: false };
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}

async function ensureJsonFile(filePath: string, fallback: unknown) {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeJsonFile(filePath, fallback);
  }
}

async function withFileLock<T>(
  filePath: string,
  fallback: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, STORE_LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // ignore unlock errors
      }
    }
  }
}

function parseTimestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pruneExpired(polls: Record<string, MSTeamsPoll>) {
  const cutoff = Date.now() - POLL_TTL_MS;
  const entries = Object.entries(polls).filter(([, poll]) => {
    const ts = parseTimestamp(poll.updatedAt ?? poll.createdAt) ?? 0;
    return ts >= cutoff;
  });
  return Object.fromEntries(entries);
}

function pruneToLimit(polls: Record<string, MSTeamsPoll>) {
  const entries = Object.entries(polls);
  if (entries.length <= MAX_POLLS) return polls;
  entries.sort((a, b) => {
    const aTs = parseTimestamp(a[1].updatedAt ?? a[1].createdAt) ?? 0;
    const bTs = parseTimestamp(b[1].updatedAt ?? b[1].createdAt) ?? 0;
    return aTs - bTs;
  });
  const keep = entries.slice(entries.length - MAX_POLLS);
  return Object.fromEntries(keep);
}

export function normalizeMSTeamsPollSelections(
  poll: MSTeamsPoll,
  selections: string[],
) {
  const maxSelections = Math.max(1, poll.maxSelections);
  const mapped = selections
    .map((entry) => Number.parseInt(entry, 10))
    .filter((value) => Number.isFinite(value))
    .filter((value) => value >= 0 && value < poll.options.length)
    .map((value) => String(value));
  const limited =
    maxSelections > 1 ? mapped.slice(0, maxSelections) : mapped.slice(0, 1);
  return Array.from(new Set(limited));
}

export function createMSTeamsPollStoreFs(
  params?: MSTeamsPollStoreFsOptions,
): MSTeamsPollStore {
  const filePath = resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });
  const empty: PollStoreData = { version: 1, polls: {} };

  const readStore = async (): Promise<PollStoreData> => {
    const { value } = await readJsonFile<PollStoreData>(filePath, empty);
    const pruned = pruneToLimit(pruneExpired(value.polls ?? {}));
    return { version: 1, polls: pruned };
  };

  const writeStore = async (data: PollStoreData) => {
    await writeJsonFile(filePath, data);
  };

  const createPoll = async (poll: MSTeamsPoll) => {
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      data.polls[poll.id] = poll;
      await writeStore({ version: 1, polls: pruneToLimit(data.polls) });
    });
  };

  const getPoll = async (pollId: string) =>
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      return data.polls[pollId] ?? null;
    });

  const recordVote = async (params: {
    pollId: string;
    voterId: string;
    selections: string[];
  }) =>
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      const poll = data.polls[params.pollId];
      if (!poll) return null;
      const normalized = normalizeMSTeamsPollSelections(
        poll,
        params.selections,
      );
      poll.votes[params.voterId] = normalized;
      poll.updatedAt = new Date().toISOString();
      data.polls[poll.id] = poll;
      await writeStore({ version: 1, polls: pruneToLimit(data.polls) });
      return poll;
    });

  return { createPoll, getPoll, recordVote };
}
