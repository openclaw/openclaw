import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { buffer as readResponseBuffer } from "node:stream/consumers";
import { deserialize } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ReplyMediaAttachment } from "../auto-reply/reply-payload.js";
import * as brokerReply from "../infra/sqlite-worker-broker-reply.js";
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

type RequestResult = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export function interceptManagedImageMutationReplies(onReply: (commandType: string) => boolean) {
  const commands = new WeakMap<object, string>();
  const dispatch = brokerReply.dispatchSqliteWorkerJob;
  const receive = brokerReply.receiveSqliteWorkerReply;
  const dispatchSpy = vi
    .spyOn(brokerReply, "dispatchSqliteWorkerJob")
    .mockImplementation((slot, job, rejected) => {
      if (job.request.type === "execute") {
        const command: unknown = deserialize(job.request.input);
        if (isRecord(command) && typeof command.type === "string") {
          commands.set(job.request, command.type);
        }
      }
      return dispatch(slot, job, rejected);
    });
  const replySpy = vi
    .spyOn(brokerReply, "receiveSqliteWorkerReply")
    .mockImplementation((slot, reply, owner) => {
      if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
        const command = commands.get(slot.current.request);
        if (command && onReply(command)) {
          return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
        }
      }
      return receive(slot, reply, owner);
    });
  return () => {
    replySpy.mockRestore();
    dispatchSpy.mockRestore();
  };
}

export async function requestManagedImageHttp(
  origin: string,
  pathName: string,
  method = "GET",
  headers?: http.ClientRequestArgs["headers"],
): Promise<RequestResult> {
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    http
      .get(`${origin}${pathName}`, { method, headers, agent: false }, resolve)
      .on("error", reject);
  });
  return {
    statusCode: response.statusCode ?? 0,
    headers: response.headers,
    body: await readResponseBuffer(response),
  };
}

export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXcZ0AAAAASUVORK5CYII=";

export async function createPngDataUrl(width: number, height: number): Promise<string> {
  const buffer = createSolidPngBuffer(width, height, { r: 24, g: 64, b: 128 });
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export async function writeSource(sourcePath: string, body: string | Buffer) {
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, body);
}

export async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
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

export async function createManagedOutgoingImageBlocksWithoutHostSql(
  params: ManagedOutgoingImageTestParams,
) {
  const queries = observeHostDataSql();
  try {
    const blocks = await createManagedOutgoingImageBlocks(params);
    expect(queries.queries).toEqual([]);
    return blocks;
  } finally {
    queries.restore();
  }
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
  return expectDefined(blocks[index], `block ${index}`);
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
  const record = expectDefined(await readManagedImageRecord(attachmentId, stateDir), attachmentId);
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
  const scope = { agentId: "main", env, sessionKey: "agent:main:main", storePath };
  await replaceTestSessionEntry(scope, { sessionId: "sess-1", updatedAt: Date.now() });
  closeOpenClawAgentDatabasesForTest();
  const { loadExactSessionEntryReadOnlyResult } =
    await import("../config/sessions/session-accessor.sqlite-entry-availability.js");
  expect(loadExactSessionEntryReadOnlyResult(scope)).toMatchObject({
    found: true,
    value: { sessionKey: "agent:main:main" },
  });
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
    alt?: string;
  },
) {
  const attachmentId = options?.attachmentId ?? "11111111-1111-4111-8111-111111111111";
  const sessionKey = options?.sessionKey ?? "agent:main:main";
  const filename = options?.filename ?? "cat.png";
  const contentType = options?.contentType ?? "image/png";
  const body = options?.body ?? Buffer.from("original-image");
  const mediaId = `${randomUUID()}-${filename}`;
  const originalPath = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR, mediaId);
  await writeSource(originalPath, body);
  await insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      ...(options?.agentId ? { agentId: options.agentId } : {}),
      messageId: options?.messageId === undefined ? "msg-1" : options.messageId,
      createdAt: options?.createdAt ?? new Date().toISOString(),
      alt: options?.alt ?? "Cat",
      original: {
        mediaRoot: path.join(stateDir, "media"),
        mediaId,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType,
        width: contentType.startsWith("image/") ? 1024 : null,
        height: contentType.startsWith("image/") ? 768 : null,
        sizeBytes: body.byteLength,
        filename,
      },
    },
    stateDir,
  );
  return { attachmentId, sessionKey, originalPath };
}
