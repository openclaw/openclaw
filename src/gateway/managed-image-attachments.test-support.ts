import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ReplyMediaAttachment } from "../auto-reply/reply-payload.js";
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

export type RequestResult = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXcZ0AAAAASUVORK5CYII=";

export async function createPngDataUrl(width: number, height: number): Promise<string> {
  const buffer = createSolidPngBuffer(width, height, { r: 24, g: 64, b: 128 });
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect(error).toMatchObject({ code: "ENOENT" });
    return;
  }
  throw new Error(`expected ${targetPath} to be missing`);
}

type ManagedOutgoingImageTestParams = Omit<
  Parameters<
    (typeof import("./managed-image-attachments.js"))["createManagedOutgoingMediaBlocks"]
  >[0],
  "items"
> & {
  mediaUrls?: string[] | null;
  attachments?: ReplyMediaAttachment[] | null;
  allowLocalNonImage?: boolean;
};

export async function createManagedOutgoingImageBlocks(params: ManagedOutgoingImageTestParams) {
  const { createManagedOutgoingMediaBlocks } = await import("./managed-image-attachments.js");
  const { mediaUrls, attachments, allowLocalNonImage, ...ownerParams } = params;
  return await createManagedOutgoingMediaBlocks({
    ...ownerParams,
    items: (mediaUrls ?? []).map((url, index) => {
      const attachment = attachments?.[index];
      return Object.assign(
        { url, trustedLocal: allowLocalNonImage === true },
        typeof attachment?.name === "string" ? { filename: attachment.name } : {},
        typeof attachment?.mimeType === "string" ? { mimeType: attachment.mimeType } : {},
        typeof attachment?.durationMs === "number" ? { durationMs: attachment.durationMs } : {},
        typeof attachment?.width === "number" ? { width: attachment.width } : {},
        typeof attachment?.height === "number" ? { height: attachment.height } : {},
      );
    }),
  });
}

export async function replaceTestSessionEntry(
  scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionKey: string;
    storePath?: string;
  },
  entry: { sessionId: string; updatedAt: number },
): Promise<void> {
  const { replaceSessionEntrySync } = await import("../config/sessions/session-accessor.js");
  // Fixture seeding does not need the async entry writer's background maintenance.
  replaceSessionEntrySync(scope, entry);
}

export function requireBlock(
  blocks: readonly Record<string, unknown>[],
  index = 0,
): Record<string, unknown> {
  const block = blocks[index];
  if (!block) {
    throw new Error(`expected block ${index}`);
  }
  return block;
}

export function requireAttachmentIdFromUrl(url: unknown): string {
  expect(url).toBeTypeOf("string");
  const attachmentId = String(url).split("/").at(-2);
  if (!attachmentId) {
    throw new Error(`expected attachment id in URL ${String(url)}`);
  }
  return attachmentId;
}

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

export async function prepareManagedSessionStore(stateDir: string): Promise<string> {
  closeOpenClawAgentDatabasesForTest();
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "sessions.sqlite");
  const { replaceSessionEntrySync } = await import("../config/sessions/session-accessor.js");
  replaceSessionEntrySync(
    {
      agentId: "main",
      env,
      sessionKey: "agent:main:main",
      storePath,
    },
    { sessionId: "sess-1", updatedAt: Date.now() },
  );
  closeOpenClawAgentDatabasesForTest();
  const { loadExactSessionEntryReadOnlyResult } =
    await import("../config/sessions/session-accessor.sqlite-entry-availability.js");
  expect(
    loadExactSessionEntryReadOnlyResult({
      agentId: "main",
      env,
      sessionKey: "agent:main:main",
      storePath,
    }),
  ).toMatchObject({ found: true, value: { sessionKey: "agent:main:main" } });
  return storePath;
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
