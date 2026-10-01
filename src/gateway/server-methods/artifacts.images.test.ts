import { StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ArtifactsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { artifactsHandlers } from "./artifacts.js";
import type { GatewayClient } from "./types.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:activity-images",
  sessionId: "activity-images",
};

async function invoke(
  method: "artifacts.list" | "artifacts.download",
  params: Record<string, unknown>,
  client: GatewayClient | null = null,
) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await expectDefined(
    artifactsHandlers[method],
    "artifact handler",
  )({
    params: { sessionKey: scope.sessionKey, ...params },
    context: createDirectChatContext(),
    req: { type: "req", id: "images", method },
    client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
  });
  return expectDefined(result, "artifact response");
}

function list(params: Record<string, unknown> = {}, client: GatewayClient | null = null) {
  return invoke("artifacts.list", { type: "image", limit: 4, ...params }, client);
}

function page(result: Awaited<ReturnType<typeof list>>): ArtifactsListResult {
  expect(result.ok).toBe(true);
  return result.payload as ArtifactsListResult;
}

async function append(content: unknown) {
  await appendTranscriptMessage(scope, { message: { role: "assistant", content } });
}

describe("bounded Activity image discovery", () => {
  it("pages canonical uploaded images from mixed user media with Chat's path preference", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const urls = Array.from({ length: 5 }, (_, index) => `media://inbound/upload-${index}.png`);
      const localPath = "/synthetic/nonexistent/upload.png";
      await appendTranscriptMessage(scope, {
        message: buildPersistedUserTurnMessage({
          text: "Uploaded screenshots",
          media: [
            {
              url: "media://inbound/document.png",
              kind: "document",
              contentType: "application/pdf",
            },
            {},
            { url: "media://inbound/audio.wav", kind: "audio", contentType: "audio/wav" },
            ...urls.map((url, index) => ({
              url,
              contentType: "image/png",
              fileName: `upload-${index}.png`,
              sizeBytes: 42,
              hydrationSuppressed: true,
            })),
            { path: localPath, url: "https://images.example.test/alternate.png", kind: "image" },
          ],
        }),
      });
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let first: ArtifactsListResult;
      try {
        first = page(await list());
        expect(page(await list({ type: undefined, limit: undefined })).artifacts).toEqual([]);
        expect(reads.queries.filter((sql) => /\btranscript_events\b/i.test(sql))).toEqual([]);
      } finally {
        reads.restore();
      }
      expect(first.artifacts.map((artifact) => artifact.image?.url)).toEqual([
        localPath,
        ...urls.slice(2).toReversed(),
      ]);
      const second = page(
        await list({ cursor: expectDefined(first.nextCursor, "uploaded image cursor") }),
      );
      expect(second.artifacts.map((artifact) => artifact.image?.url)).toEqual(
        urls.slice(0, 2).toReversed(),
      );
      expect(second.artifacts[1]).toMatchObject({
        title: "upload-0.png",
        mimeType: "image/png",
        sizeBytes: 42,
        source: "session-transcript-preview",
        download: { mode: "unsupported" },
      });
      expect(second.nextCursor).toBeUndefined();
      expect(page(await list({ messageRole: "assistant" })).artifacts).toEqual([]);
    });
  });

  it("honors assistant image filters and binds pagination to the same role", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const urls = Array.from(
        { length: 6 },
        (_, index) => `https://images.example.test/assistant-${index}.png`,
      );
      await append(urls.map((url) => ({ type: "image", url })));
      for (const role of ["user", "toolResult"]) {
        await appendTranscriptMessage(scope, {
          message: {
            role,
            content: [{ type: "image", url: `https://images.example.test/${role}.png` }],
          },
        });
      }
      const all = page(await list());
      expect(all.artifacts.slice(0, 2).map((artifact) => artifact.image?.url)).toEqual([
        "https://images.example.test/toolResult.png",
        "https://images.example.test/user.png",
      ]);
      const filtered = page(await list({ messageRole: "assistant" }));
      expect(filtered.artifacts.map((artifact) => artifact.image?.url)).toEqual(
        urls.toReversed().slice(0, 4),
      );
      expect(await list({ cursor: filtered.nextCursor })).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_cursor_invalid" } },
      });
      expect(await list({ cursor: all.nextCursor, messageRole: "assistant" })).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_cursor_invalid" } },
      });
      const remaining = page(await list({ cursor: filtered.nextCursor, messageRole: "assistant" }));
      expect(remaining.artifacts.map((artifact) => artifact.image?.url)).toEqual(
        urls.slice(0, 2).toReversed(),
      );
      expect(remaining.nextCursor).toBeUndefined();
    });
  });

  it("pages newest images within one message and includes Markdown local images without reading files", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await append([{ type: "image", data: "aGVsbG8=", mimeType: "image/png", alt: "inline" }]);
      await append(
        Array.from({ length: 5 }, (_, index) => ({
          type: "image",
          url: `https://images.example.test/${index}.png`,
          alt: `image-${index}`,
        })),
      );
      await append(
        "![Screenshot](/synthetic/nonexistent/screenshot.png)\n`![code](/private/code.png)`\n```md\n![fenced](/private/fenced.png)\n```",
      );
      const first = page(await list());
      expect(first.artifacts.map((artifact) => artifact.image?.url)).toEqual([
        "/synthetic/nonexistent/screenshot.png",
        "https://images.example.test/4.png",
        "https://images.example.test/3.png",
        "https://images.example.test/2.png",
      ]);
      expect(first.artifacts[0]?.download.mode).toBe("unsupported");
      await append([{ type: "image", url: "https://images.example.test/new.png" }]);
      const second = page(await list({ cursor: first.nextCursor }));
      expect(second.artifacts.map((artifact) => artifact.image?.url)).toEqual([
        "https://images.example.test/1.png",
        "https://images.example.test/0.png",
        "data:image/png;base64,aGVsbG8=",
      ]);
      expect(second.artifacts[2]).toMatchObject({
        id: expect.stringMatching(/^artifact_transcript_image_/),
        type: "image",
        title: "inline",
        mimeType: "image/png",
        sizeBytes: 5,
        source: "session-transcript",
        download: { mode: "bytes" },
        image: { url: "data:image/png;base64,aGVsbG8=" },
      });
      expect(second.nextCursor).toBeUndefined();
    });
  });

  it("bounds sparse transcript work and continues into older messages", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await append([{ type: "image", url: "https://images.example.test/old.png" }]);
      for (let index = 0; index < 40; index++) {
        await append(`text-${index}`);
      }
      const first = page(await list());
      expect(first.artifacts).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = page(await list({ cursor: first.nextCursor }));
      expect(second.artifacts).toHaveLength(1);
      expect(await list({ limit: 5 })).toMatchObject({ ok: false });
      expect(await list({ type: undefined, limit: 2 })).toMatchObject({ ok: false });
    });
  });

  it("discovers oversized inline images as downloadable references after newer text", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const data = Buffer.alloc(1.5 * 1024 * 1024, 1).toString("base64");
      await append([{ type: "image", data, mimeType: "image/png", title: "Screenshot" }]);
      await append("newer text");
      await append("newest text");
      const first = page(await list());
      expect(first.artifacts).toEqual([]);
      const oversized = page(
        await list({ cursor: expectDefined(first.nextCursor, "image cursor") }),
      );
      expect(oversized.artifacts).toHaveLength(1);
      const image = expectDefined(oversized.artifacts[0], "inline image reference");
      expect(image).toMatchObject({
        id: expect.stringMatching(/^artifact_transcript_image_/),
        type: "image",
        title: "Screenshot",
        mimeType: "image/png",
        sizeBytes: 1.5 * 1024 * 1024,
        source: "session-transcript",
        download: { mode: "bytes" },
      });
      expect(image).not.toHaveProperty("image");
      expect(oversized).not.toHaveProperty("omittedOversized");
      expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(2 * 1024);
      expect(oversized.nextCursor).toBeUndefined();
      expect(await invoke("artifacts.download", { artifactId: image.id })).toMatchObject({
        ok: true,
        payload: { encoding: "base64", data },
      });
    });
  });

  it("bounds inline previews for images without transcript download references", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const url = "data:image/png;base64,aGVsbG8=";
      await append([
        { type: "image", url },
        { type: "image", source: { url } },
        { type: "image", url: `data:image/png;base64,${"a".repeat(256 * 1024)}` },
        { type: "image_url", image_url: { url } },
        { type: "attachment", attachment: { kind: "image", url } },
      ]);
      const newest = page(await list({ limit: 2 }));
      expect(newest).not.toHaveProperty("omittedOversized");
      const older = page(await list({ cursor: newest.nextCursor, limit: 1 }));
      expect(older.omittedOversized).toBe(true);
      const oldest = page(await list({ cursor: older.nextCursor, limit: 1 }));
      expect(oldest).not.toHaveProperty("omittedOversized");
      expect(oldest.nextCursor).toBeUndefined();
      const previews = page(await list());
      expect(previews.artifacts).toHaveLength(4);
      expect(previews.omittedOversized).toBe(true);
      expect(previews.nextCursor).toBeUndefined();
      for (const artifact of previews.artifacts) {
        expect(artifact).toMatchObject({
          id: expect.stringMatching(/^preview_/),
          type: "image",
          source: "session-transcript-preview",
          download: { mode: "unsupported" },
          image: { url },
        });
      }
      await append([
        { type: "input_image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "input_image", source: { data: "aGVsbG8=", media_type: "image/png" } },
      ]);
      expect(page(await list({ limit: 2 })).artifacts).toEqual([
        expect.objectContaining({ image: { url }, download: { mode: "unsupported" } }),
        expect.objectContaining({ image: { url }, download: { mode: "unsupported" } }),
      ]);
    });
  });

  it("rejects copied, retargeted, and reset cursors while rechecking current session access", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await append(
        Array.from({ length: 6 }, (_, index) => ({
          type: "image",
          url: `https://images.example.test/${index}.png`,
        })),
      );
      const client = sharingPolicyClient({ user: "image-viewer", scopes: ["operator.read"] });
      const first = page(await list({}, client));
      const cursor = expectDefined(first.nextCursor, "image cursor");
      expect(
        await list(
          { cursor },
          sharingPolicyClient({ user: "image-viewer", scopes: ["operator.read"] }),
        ),
      ).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_cursor_invalid" } },
      });
      const other = { ...scope, sessionKey: "agent:main:other-images", sessionId: "other-images" };
      await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
      expect(await list({ cursor, sessionKey: other.sessionKey }, client)).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_cursor_invalid" } },
      });
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 2,
        incognito: true,
      });
      expect(await list({ cursor }, client)).toMatchObject({ ok: false });
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 3,
        incognito: undefined,
      });
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "reset-image-window",
        timestamp: new Date().toISOString(),
      });
      expect(await list({ cursor }, client)).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_cursor_invalid" } },
      });
    });
  });
});
