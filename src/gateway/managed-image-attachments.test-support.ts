import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "./managed-image-record-store.js";

export async function requireManagedOriginalPath(
  stateDir: string,
  attachmentId: string,
): Promise<string> {
  const record = await readManagedImageRecord(attachmentId, stateDir);
  if (!record) {
    throw new Error(`expected managed image record ${attachmentId}`);
  }
  return path.join(stateDir, "media", record.original.mediaSubdir, record.original.mediaId);
}

export function prepareAgentSessionStore(stateDir: string, agentId: string): void {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawAgentDatabase({ agentId, env });
  closeOpenClawAgentDatabasesForTest();
}

export function usePreparedManagedImageState(params: {
  prefix: string;
  bindState: (stateDir: string) => void;
  prepareSessionStore: (stateDir: string) => Promise<void>;
  resetMocks: (stateDir: string) => void;
  cleanupRecords: (params: {
    stateDir: string;
    forceDeleteSessionRecords: true;
  }) => Promise<unknown>;
}): void {
  let stateDir: string;
  const suiteDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      if (stateDir) {
        await closeOpenClawStateDatabaseByPathAsync(
          resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
        );
        closeOpenClawAgentDatabasesForTest();
      }
      cleanup();
    }),
  );
  beforeAll(async () => {
    stateDir = suiteDirs.make(params.prefix);
    params.bindState(stateDir);
    await params.prepareSessionStore(stateDir);
  });
  beforeEach(() => params.resetMocks(stateDir));
  afterEach(async () => {
    await params.cleanupRecords({ stateDir, forceDeleteSessionRecords: true });
    // Keep both database identities and their workers; discard only case-owned artifacts.
    const retained = new Set([
      "state",
      "sessions.sqlite",
      "sessions.sqlite-wal",
      "sessions.sqlite-shm",
    ]);
    await Promise.all(
      (await fs.readdir(stateDir))
        .filter((name) => !retained.has(name))
        .map((name) => fs.rm(path.join(stateDir, name), { recursive: true, force: true })),
    );
  });
}

export async function createFixture(
  stateDir: string,
  options?: {
    sessionKey?: string;
    agentId?: string;
    attachmentId?: string;
    filename?: string;
    contentType?: string;
    body?: Buffer;
    messageId?: string | null;
    createdAt?: string;
  },
) {
  const attachmentId = options?.attachmentId ?? "11111111-1111-4111-8111-111111111111";
  const sessionKey = options?.sessionKey ?? "agent:main:main";
  const filename = options?.filename ?? "cat.png";
  const mediaId = `${randomUUID()}-${filename}`;
  const originalPath = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR, mediaId);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  const body = options?.body ?? Buffer.from("original-image");
  await fs.writeFile(originalPath, body);
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      ...(options?.agentId ? { agentId: options.agentId } : {}),
      messageId: options?.messageId === undefined ? "msg-1" : options.messageId,
      createdAt: options?.createdAt ?? new Date().toISOString(),
      alt: "Cat",
      original: {
        mediaRoot: path.join(stateDir, "media"),
        mediaId,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: options?.contentType ?? "image/png",
        width: options?.contentType?.startsWith("image/") === false ? null : 1024,
        height: options?.contentType?.startsWith("image/") === false ? null : 768,
        sizeBytes: body.byteLength,
        filename,
      },
    },
    stateDir,
  );
  return { attachmentId, sessionKey, originalPath };
}
