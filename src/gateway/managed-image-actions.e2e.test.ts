import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  publishEncodedSessionTranscriptArchive,
  resolveSqliteTranscriptArchivePath,
} from "../config/sessions/session-accessor.sqlite-archive-artifact.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readImageProbeFromHeader } from "../media/image-ops.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { isGatewayProtocolResponseError } from "./client.js";
import {
  cleanupManagedOutgoingMediaRecords,
  createManagedOutgoingMediaBlocks,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX,
} from "./managed-image-attachments.js";
import {
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
  type ManagedImageRecord,
  type ManagedImageRecordDatabase,
} from "./managed-image-record-store.js";
import { readSessionMessagesWithSourceAsync } from "./session-transcript-readers.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import {
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GATEWAY_TOKEN = "managed-image-actions-e2e-token";
const SESSION_KEY = "agent:main:main";

function prepareStore() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for managed artifact fixtures");
  }
  testState.gatewayAuth = { mode: "token", token: GATEWAY_TOKEN };
  const storePath = path.join(stateDir, "sessions.sqlite");
  testState.sessionStorePath = storePath;
  return { stateDir, storePath };
}

async function expectBytes(url: URL, bytes: Buffer, mimeType?: string, options?: RequestInit) {
  const response = await fetch(url, options);
  expect(response.status).toBe(200);
  if (mimeType) {
    expect(response.headers.get("content-type")).toBe(mimeType);
  }
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  return response;
}

async function expectNotFound(url: URL, options?: RequestInit) {
  const response = await fetch(url, options);
  expect(response.status).toBe(404);
  expect((await response.text()) === "not found").toBe(true);
}

async function expectArtifactNotFound(request: Promise<unknown>) {
  let rejected = false;
  try {
    await request;
  } catch (error) {
    rejected =
      isGatewayProtocolResponseError(error) &&
      error.code === "INVALID_REQUEST" &&
      typeof error.details === "object" &&
      error.details !== null &&
      "type" in error.details &&
      error.details.type === "artifact_not_found";
  }
  // Never print a successful response: it may contain a bearer URL.
  expect(rejected).toBe(true);
}

describe("managed image actions Gateway E2E", () => {
  test.each(["fresh", "v2026.9.4 retained"] as const)(
    "downloads %s image and document bytes by run scope and rejects stale IDs",
    async (provenance) => {
      const { stateDir, storePath } = prepareStore();
      const sessionId = `scoped-artifacts-${randomUUID()}`;
      const sessionKey = `agent:main:${sessionId}`;
      const messageId = "delivered-files";
      const runId = "delivered-files-run";
      const timestamp = "2026-09-04T00:00:00.000Z";
      const scope = { agentId: "main", sessionId, sessionKey, storePath };
      const blocks: Record<string, unknown>[] = [];
      const artifacts: Array<{
        id: string;
        staleId: string;
        name: string;
        title: string;
        mimeType: string;
        bytes: Buffer;
      }> = [];
      for (const kind of ["image", "document"] as const) {
        const bytes =
          kind === "image"
            ? await fs.readFile(path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"))
            : Buffer.from("item,value\nretained,42\n");
        const name = kind === "image" ? "scoped-image.png" : "scoped-table.csv";
        const mimeType = kind === "image" ? "image/png" : "text/csv";
        const prefix =
          kind === "image"
            ? MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX
            : MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX;
        let block: Record<string, unknown>;
        if (provenance === "fresh") {
          const sourceDir = path.join(stateDir, "scoped-artifact-sources");
          const sourcePath = path.join(sourceDir, name);
          if (kind === "document") {
            // Documents use trusted file ingestion; data URLs admit image/audio/video only.
            await fs.mkdir(sourceDir, { recursive: true });
            await fs.writeFile(sourcePath, bytes);
          }
          const created = await createManagedOutgoingMediaBlocks({
            sessionKey,
            messageId,
            stateDir,
            localRoots: [sourceDir],
            items: [
              {
                url:
                  kind === "image"
                    ? `data:${mimeType};base64,${bytes.toString("base64")}`
                    : sourcePath,
                filename: name,
                trustedLocal: kind === "document",
              },
            ],
          });
          const selected = created.find(
            (candidate) => candidate.type === (kind === "image" ? "image" : "attachment"),
          );
          if (!selected) {
            throw new Error("managed artifact fixture did not produce a block");
          }
          block = selected;
        } else {
          const attachmentId = randomUUID();
          const mediaRoot = path.join(stateDir, "media");
          const mediaId = `${attachmentId}${path.extname(name)}`;
          const originalPath = path.join(mediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR, mediaId);
          await fs.mkdir(path.dirname(originalPath), { recursive: true });
          await fs.writeFile(originalPath, bytes);
          const imageSize = kind === "image" ? readImageProbeFromHeader(bytes) : undefined;
          const record: ManagedImageRecord = {
            attachmentId,
            sessionKey,
            messageId,
            createdAt: timestamp,
            retentionClass: "history",
            alt: name,
            original: {
              mediaRoot,
              mediaId,
              mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
              contentType: mimeType,
              width: imageSize?.width ?? null,
              height: imageSize?.height ?? null,
              sizeBytes: bytes.length,
              filename: name,
            },
          };
          // Source-derived v2026.9.4 row/block format, not an old-binary upgrade.
          // Keep the old writer's omitted agent ID and literal columns independent of today's codec.
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<ManagedImageRecordDatabase>(db)
                  .insertInto("managed_outgoing_image_records")
                  .values({
                    attachment_id: attachmentId,
                    session_key: sessionKey,
                    agent_id: null,
                    message_id: messageId,
                    created_at: timestamp,
                    updated_at: null,
                    retention_class: "history",
                    alt: name,
                    original_media_root: mediaRoot,
                    original_media_id: mediaId,
                    original_media_subdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
                    original_content_type: mimeType,
                    original_width: record.original.width,
                    original_height: record.original.height,
                    original_size_bytes: bytes.length,
                    original_filename: name,
                    cleanup_pending: 0,
                    record_json: JSON.stringify(record),
                  }),
              );
            },
            { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
          );
          const artifactId = `${prefix}${attachmentId}`;
          const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
          block =
            kind === "image"
              ? {
                  type: kind,
                  artifactId,
                  url,
                  openUrl: url,
                  alt: name,
                  mimeType,
                  width: record.original.width,
                  height: record.original.height,
                  sizeBytes: bytes.length,
                }
              : {
                  type: "attachment",
                  attachment: {
                    artifactId,
                    url,
                    kind,
                    label: name,
                    mimeType,
                    sizeBytes: bytes.length,
                  },
                };
        }
        const payload = kind === "image" ? block : (block.attachment as Record<string, unknown>);
        if (typeof payload.artifactId !== "string" || typeof payload.url !== "string") {
          throw new Error("managed artifact fixture is missing its ID or URL");
        }
        const staleId = `${prefix}${randomUUID()}`;
        const stale = {
          ...payload,
          artifactId: staleId,
          data: Buffer.from("different inline bytes").toString("base64"),
        };
        blocks.push(block, kind === "image" ? stale : { type: "attachment", attachment: stale });
        artifacts.push({
          id: payload.artifactId,
          staleId,
          name,
          title: provenance === "fresh" && kind === "image" ? "Generated image 1" : name,
          mimeType,
          bytes,
        });
      }
      await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: stateDir },
        {
          type: "message",
          id: messageId,
          parentId: null,
          timestamp,
          message: {
            role: "assistant",
            content: blocks,
            timestamp: Date.parse(timestamp),
            __openclaw: { id: messageId, runId },
          },
        },
      ]);
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      await withGatewayServer(
        async ({ port }) => {
          const client = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token: GATEWAY_TOKEN,
            scopes: ["operator.read"],
          });
          try {
            for (const artifact of artifacts) {
              const query = { sessionKey, runId, messageRole: "assistant" };
              const download = await client
                .request<{
                  artifact: Record<string, unknown>;
                  url?: string;
                  data?: string;
                }>("artifacts.download", { ...query, artifactId: artifact.id })
                .catch((cause: unknown) => {
                  throw new Error(
                    `Managed artifact download failed: ${JSON.stringify({ provenance, ...query, artifactId: artifact.id, name: artifact.name })}`,
                    { cause },
                  );
                });
              expect(download.artifact).toMatchObject({
                id: artifact.id,
                title: artifact.title,
                mimeType: artifact.mimeType,
                sizeBytes: artifact.bytes.length,
                sessionKey,
                runId,
              });
              expect(download.data).toBeUndefined();
              const response = await expectBytes(
                new URL(download.url ?? "", `http://127.0.0.1:${port}`),
                artifact.bytes,
                artifact.mimeType,
              );
              expect(response.headers.get("content-disposition")).toContain(artifact.name);
              await expectArtifactNotFound(
                client.request("artifacts.download", {
                  ...query,
                  artifactId: artifact.staleId,
                }),
              );
            }
          } finally {
            await disconnectGatewayClient(client);
          }
        },
        { serverOptions: { auth: { mode: "token", token: GATEWAY_TOKEN } } },
      );
    },
  );

  test("issues one transcript ticket for full and thumbnail image bytes", async () => {
    const { stateDir, storePath } = prepareStore();
    testState.gatewayControlUi = { basePath: "/rosita" };

    const source = await fs.readFile(
      path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
    );
    const messageId = "managed-image-actions-message";
    const blocks = await createManagedOutgoingMediaBlocks({
      sessionKey: SESSION_KEY,
      messageId,
      items: [
        {
          url: `data:image/png;base64,${source.toString("base64")}`,
          trustedLocal: false,
        },
      ],
      stateDir,
    });
    const block = blocks.find(
      (candidate) =>
        candidate.type === "image" &&
        typeof candidate.artifactId === "string" &&
        candidate.artifactId.startsWith(MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX),
    );
    if (!block || typeof block.artifactId !== "string" || typeof block.url !== "string") {
      throw new Error("managed image fixture did not produce an artifact");
    }
    const artifactId = block.artifactId;
    const imageUrl = block.url;

    const sessionId = "managed-image-actions-session";
    const transcriptPath = path.join(stateDir, `${sessionId}.jsonl`);
    const timestamp = new Date().toISOString();
    const transcriptEvents = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: stateDir },
      {
        type: "message",
        id: messageId,
        parentId: null,
        timestamp,
        message: {
          role: "assistant",
          content: blocks,
          timestamp: Date.now(),
          __openclaw: { id: messageId },
        },
      },
    ];
    const transcriptBytes = Buffer.from(
      transcriptEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    await fs.writeFile(transcriptPath, transcriptBytes);
    await writeSessionStore({
      entries: {
        [SESSION_KEY]: {
          sessionId,
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    await withGatewayServer(
      async ({ port }) => {
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: GATEWAY_TOKEN,
          scopes: ["operator.read"],
        });
        try {
          const download = await client.request<{
            artifact?: { id?: string; source?: string };
            url?: string;
            expiresAt?: string;
          }>("artifacts.download", {
            sessionKey: SESSION_KEY,
            artifactId,
          });
          expect(download.artifact).toMatchObject({
            id: artifactId,
            source: "session-transcript",
          });
          expect(download.expiresAt).toEqual(expect.any(String));
          const fullUrl = new URL(download.url ?? "", `http://127.0.0.1:${port}`);
          expect(fullUrl.searchParams.get("mediaTicket")).toBeTruthy();

          await expectBytes(fullUrl, source, "image/png");
          fullUrl.pathname = `/rosita${fullUrl.pathname}`;
          await expectBytes(fullUrl, source);
          expect(readImageProbeFromHeader(source)).toMatchObject({
            width: 1280,
            height: 358,
          });

          const thumbnailUrl = new URL(fullUrl);
          thumbnailUrl.pathname = thumbnailUrl.pathname.replace(/\/full$/u, "/thumbnail");
          const thumbnail = await fetch(thumbnailUrl);
          expect(thumbnail.status).toBe(200);
          expect(thumbnail.headers.get("content-type")).toBe("image/webp");
          const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer());
          expect(readImageProbeFromHeader(thumbnailBytes)).toMatchObject({
            format: "webp",
            width: 960,
            height: 269,
          });
          expect(thumbnailBytes.byteLength).toBeLessThanOrEqual(256 * 1024);

          await expectBytes(new URL(imageUrl, fullUrl), source, undefined, {
            headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
          });

          const wrongIdentity = new URL(fullUrl);
          wrongIdentity.pathname = wrongIdentity.pathname.replace(
            /\/[0-9a-f-]+\/full$/u,
            "/22222222-2222-4222-8222-222222222222/full",
          );
          await expectNotFound(wrongIdentity, {
            headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
          });

          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(Date.parse(download.expiresAt ?? "") + 1);
          try {
            await expectNotFound(fullUrl);
          } finally {
            vi.useRealTimers();
          }

          const renewed = await client.request<{ url: string }>("artifacts.download", {
            sessionKey: SESSION_KEY,
            artifactId,
          });
          fullUrl.search = new URL(renewed.url, fullUrl).search;
          thumbnailUrl.search = fullUrl.search;

          const scope = { agentId: "main", sessionKey: SESSION_KEY, sessionId, storePath };
          // Retire the imported fixture: archive selection must not see an obsolete active file.
          await fs.rm(transcriptPath);
          await replaceTranscriptEvents(scope, transcriptEvents.slice(0, 1));
          const archiveDirectory = path.dirname(storePath);
          const archiveHash = createHash("sha256").update(transcriptBytes).digest("hex");
          const archivePath = publishEncodedSessionTranscriptArchive({
            archiveDirectory,
            archiveName: path.basename(
              resolveSqliteTranscriptArchivePath({
                archiveDirectory,
                identityOwner: "filename",
                sessionId,
                reason: "reset",
                nowMs: Date.parse(timestamp),
              }),
            ),
            bytes: transcriptBytes,
            sha256: archiveHash,
          });
          const archiveBefore = await fs.stat(archivePath);
          await expectBytes(fullUrl, source);
          await expectBytes(thumbnailUrl, thumbnailBytes);

          await replaceTranscriptEvents(scope, [
            ...transcriptEvents.slice(0, 1),
            {
              type: "message",
              id: "managed-image-actions-live-replacement",
              parentId: null,
              timestamp,
              message: { role: "assistant", content: "Live history without the old image" },
            },
          ]);
          const activeHistory = await readSessionMessagesWithSourceAsync(scope, {
            mode: "page",
            allowResetArchiveFallback: true,
          });
          expect(activeHistory.messages).toHaveLength(1);
          expect(activeHistory.messages[0]).toMatchObject({
            content: "Live history without the old image",
            __openclaw: { id: "managed-image-actions-live-replacement" },
          });
          for (const variant of ["full", "thumbnail"] as const) {
            for (const credential of ["ticket", "bearer"] as const) {
              const revokedUrl = new URL(variant === "full" ? fullUrl : thumbnailUrl);
              if (credential === "bearer") {
                revokedUrl.searchParams.delete("mediaTicket");
              }
              await expectNotFound(
                revokedUrl,
                credential === "bearer"
                  ? { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } }
                  : undefined,
              );
            }
          }
          await expectArtifactNotFound(
            client.request("artifacts.download", { sessionKey: SESSION_KEY, artifactId }),
          );
          const archiveAfter = await fs.stat(archivePath);
          expect([archiveAfter.size, archiveAfter.mtimeMs]).toEqual([
            archiveBefore.size,
            archiveBefore.mtimeMs,
          ]);
          expect(
            createHash("sha256")
              .update(await fs.readFile(archivePath))
              .digest("hex"),
          ).toBe(archiveHash);
          expect(
            (await readManagedImageRecord(
              artifactId.slice(MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX.length),
              stateDir,
            )) !== null,
          ).toBe(true);
          await replaceTranscriptEvents(scope, transcriptEvents);

          await disconnectGatewayClient(client);
          await expectBytes(fullUrl, source);

          const record = await readManagedImageRecord(
            artifactId.slice(MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX.length),
            stateDir,
          );
          if (!record) {
            throw new Error("managed image record disappeared before cleanup");
          }
          const originalPath = path.join(
            record.original.mediaRoot,
            record.original.mediaSubdir,
            record.original.mediaId,
          );
          await cleanupManagedOutgoingMediaRecords({
            stateDir,
            sessionKey: SESSION_KEY,
            forceDeleteSessionRecords: true,
          });
          expect(await readManagedImageRecord(record.attachmentId, stateDir)).toBeNull();
          await expect(fs.access(originalPath)).rejects.toMatchObject({ code: "ENOENT" });

          await expectNotFound(fullUrl);
        } finally {
          await disconnectGatewayClient(client).catch(() => {});
        }
      },
      { serverOptions: { auth: { mode: "token", token: GATEWAY_TOKEN } } },
    );
  });
});
