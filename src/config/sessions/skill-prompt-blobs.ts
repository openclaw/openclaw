import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "../../infra/json-files.js";
import type { SessionEntry, SessionSkillPromptRef, SessionSkillSnapshot } from "./types.js";

const PROMPT_BLOB_DIR = "skills-prompts";
const PROMPT_BLOB_ALGORITHM: SessionSkillPromptRef["algorithm"] = "sha256";
const PROMPT_BLOB_VERSION: SessionSkillPromptRef["version"] = 1;
const MIN_PROMPT_BLOB_CHARS = 512;
const MAX_PROMPT_BLOB_BYTES = 512 * 1024;

type PersistedSessionStore = {
  store: Record<string, SessionEntry>;
  changed: boolean;
};

export type SessionSkillPromptBlobProjection = {
  ref: SessionSkillPromptRef;
  path: string | null;
  prompt: string;
};

export type SessionStorePersistenceProjection = PersistedSessionStore & {
  promptBlobs: Map<string, SessionSkillPromptBlobProjection>;
};

function hashPrompt(prompt: string): string {
  return crypto.createHash(PROMPT_BLOB_ALGORITHM).update(prompt).digest("hex");
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function resolveSessionSkillPromptBlobPath(storePath: string, hash: string): string | null {
  if (!isSha256Hex(hash)) {
    return null;
  }
  return path.join(
    path.dirname(path.resolve(storePath)),
    PROMPT_BLOB_DIR,
    PROMPT_BLOB_ALGORITHM,
    hash.slice(0, 2),
    `${hash}.txt`,
  );
}

function buildPromptRef(prompt: string): SessionSkillPromptRef {
  return {
    version: PROMPT_BLOB_VERSION,
    algorithm: PROMPT_BLOB_ALGORITHM,
    hash: hashPrompt(prompt),
    bytes: Buffer.byteLength(prompt, "utf8"),
  };
}

function shouldStorePromptAsBlob(prompt: string): boolean {
  const bytes = Buffer.byteLength(prompt, "utf8");
  return prompt.length >= MIN_PROMPT_BLOB_CHARS && bytes <= MAX_PROMPT_BLOB_BYTES;
}

function readValidPromptBlob(storePath: string, ref: SessionSkillPromptRef): string | null {
  if (
    ref.version !== PROMPT_BLOB_VERSION ||
    ref.algorithm !== PROMPT_BLOB_ALGORITHM ||
    !isSha256Hex(ref.hash) ||
    typeof ref.bytes !== "number" ||
    !Number.isFinite(ref.bytes) ||
    ref.bytes < 0 ||
    ref.bytes > MAX_PROMPT_BLOB_BYTES
  ) {
    return null;
  }
  const blobPath = resolveSessionSkillPromptBlobPath(storePath, ref.hash);
  if (!blobPath) {
    return null;
  }
  try {
    const stat = fs.statSync(blobPath);
    if (!stat.isFile() || stat.size !== ref.bytes) {
      return null;
    }
    const prompt = fs.readFileSync(blobPath, "utf8");
    return hashPrompt(prompt) === ref.hash && Buffer.byteLength(prompt, "utf8") === ref.bytes
      ? prompt
      : null;
  } catch {
    return null;
  }
}

async function ensurePromptBlob(storePath: string, prompt: string): Promise<SessionSkillPromptRef> {
  const ref = buildPromptRef(prompt);
  const blobPath = resolveSessionSkillPromptBlobPath(storePath, ref.hash);
  if (!blobPath) {
    return ref;
  }
  if (readValidPromptBlob(storePath, ref) !== prompt) {
    await fs.promises.mkdir(path.dirname(blobPath), { recursive: true });
    await writeTextAtomic(blobPath, prompt, {
      durable: false,
      mode: 0o600,
      tempPrefix: path.basename(blobPath),
    });
  }
  return ref;
}

function stripPromptForPersistence(entry: SessionEntry, ref: SessionSkillPromptRef): SessionEntry {
  const { prompt: _prompt, ...snapshot } = entry.skillsSnapshot!;
  return {
    ...entry,
    skillsSnapshot: {
      ...snapshot,
      promptRef: ref,
    } as SessionSkillSnapshot,
  };
}

export function projectSessionStoreForPersistence(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): SessionStorePersistenceProjection {
  let persisted = params.store;
  let changed = false;
  const promptBlobs = new Map<string, SessionSkillPromptBlobProjection>();
  for (const [key, entry] of Object.entries(params.store)) {
    const prompt = entry.skillsSnapshot?.prompt;
    if (!prompt || !shouldStorePromptAsBlob(prompt)) {
      continue;
    }
    const promptRef = buildPromptRef(prompt);
    promptBlobs.set(promptRef.hash, {
      ref: promptRef,
      path: resolveSessionSkillPromptBlobPath(params.storePath, promptRef.hash),
      prompt,
    });
    if (persisted === params.store) {
      persisted = { ...params.store };
    }
    persisted[key] = stripPromptForPersistence(entry, promptRef);
    changed = true;
  }
  return { store: persisted, changed, promptBlobs };
}

export async function prepareSessionStoreForPersistence(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): Promise<PersistedSessionStore> {
  const projected = projectSessionStoreForPersistence(params);
  for (const blob of projected.promptBlobs.values()) {
    await ensurePromptBlob(params.storePath, blob.prompt);
  }
  return projected;
}

function parsePromptRef(value: unknown): SessionSkillPromptRef | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const ref = value as Partial<SessionSkillPromptRef>;
  return ref.version === PROMPT_BLOB_VERSION &&
    ref.algorithm === PROMPT_BLOB_ALGORITHM &&
    typeof ref.hash === "string" &&
    typeof ref.bytes === "number"
    ? {
        version: ref.version,
        algorithm: ref.algorithm,
        hash: ref.hash,
        bytes: ref.bytes,
      }
    : null;
}

export function hydrateSessionStoreSkillPromptRefs(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(params.store)) {
    const snapshot = entry.skillsSnapshot;
    if (!snapshot || typeof snapshot.prompt === "string") {
      continue;
    }
    const promptRef = parsePromptRef((snapshot as { promptRef?: unknown }).promptRef);
    const prompt = promptRef ? readValidPromptBlob(params.storePath, promptRef) : null;
    if (!prompt) {
      params.store[key] = { ...entry };
      delete params.store[key].skillsSnapshot;
      changed = true;
      continue;
    }
    const { promptRef: _promptRef, ...rest } = snapshot as typeof snapshot & {
      promptRef?: SessionSkillPromptRef;
    };
    params.store[key] = {
      ...entry,
      skillsSnapshot: {
        ...rest,
        prompt,
      },
    };
    changed = true;
  }
  return changed;
}
