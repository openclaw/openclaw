import { StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readTranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { materializeRuntimeConfig } from "../../config/materialize.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { rolePolicyConfig, sharingPolicyClient } from "../session-sharing.test-utils.js";
import { projectSessionMessagePayload } from "../session-transcript-message.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import { prepareAgentSession } from "./agent-session-prepare.js";
import * as transcriptImageArtifacts from "./artifacts-transcript-images.js";
import { artifactsHandlers } from "./artifacts.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

function sessionScope(
  sessionId: string,
  agentId = "main",
  sessionKey = `agent:${agentId}:${sessionId}`,
) {
  return { agentId, sessionKey, sessionId };
}
const scope = sessionScope("activity-images");
const imageUrl = (name: string | number) => `https://images.example.test/${name}.png`;
const imageUrlsFor = (count: number, prefix = "") =>
  Array.from({ length: count }, (_, i) => imageUrl(`${prefix}${i}`));
const imageMessage = (data: string, role = "assistant") => ({
  role,
  content: [{ type: "image", data, mimeType: "image/png" }],
});
const withState = (run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, run);

async function configuredState(state: OpenClawTestState, source: OpenClawConfig) {
  await state.writeConfig(source);
  const config = materializeRuntimeConfig(source, {
    env: state.env,
    manifestRegistry: { plugins: [] },
  });
  setRuntimeConfigSnapshot(config, source);
  return config;
}

async function invoke(
  method: "chat.history" | "artifacts.list" | "artifacts.get" | "artifacts.download",
  params: Record<string, unknown>,
  client: GatewayClient | null = null,
  context: GatewayRequestContext = createDirectChatContext(),
  sessionKey = scope.sessionKey,
) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await expectDefined(
    method === "chat.history" ? chatHistoryHandlers[method] : artifactsHandlers[method],
    "artifact handler",
  )({
    params: { sessionKey, ...params },
    context,
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

function imageUrls(result: ArtifactsListResult) {
  return result.artifacts.map((artifact) => artifact.image?.url);
}

async function append(content: unknown, role = "assistant") {
  await appendTranscriptMessage(scope, { message: { role, content } });
}

function withImages(run: () => Promise<void>) {
  return withState(async () => {
    await captureRuntimeConfigAsyncReader()();
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await run();
  });
}

function expectArtifactError(result: Awaited<ReturnType<typeof invoke>>, type: string) {
  expect(result).toMatchObject({ ok: false, error: { details: { type } } });
}

function expectArtifacts(
  result: Awaited<ReturnType<typeof invoke>>,
  artifacts: unknown[],
  soft = false,
) {
  (soft ? expect.soft : expect)(result).toMatchObject({ ok: true, payload: { artifacts } });
}

function fileMessage(title: string, data = "aGVsbG8=", runId?: string) {
  return {
    role: "assistant",
    content: [{ type: "file", data, mimeType: "text/plain", title }],
    ...(runId ? { __openclaw: { runId } } : {}),
  };
}

async function seedMessage(
  target: typeof scope,
  message: unknown,
  eventId?: string,
  updatedAt = 1,
) {
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt });
  return appendTranscriptMessage(target, { message, eventId });
}

describe("bounded Activity image discovery", () => {
  it("pages canonical uploaded images from mixed user media with Chat's path preference", async () => {
    await withImages(async () => {
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
      expect(imageUrls(first)).toEqual([localPath, ...urls.slice(2).toReversed()]);
      const second = page(
        await list({ cursor: expectDefined(first.nextCursor, "uploaded image cursor") }),
      );
      expect(imageUrls(second)).toEqual(urls.slice(0, 2).toReversed());
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
    await withImages(async () => {
      const urls = imageUrlsFor(6, "assistant-");
      await append(urls.map((url) => ({ type: "image", url })));
      for (const role of ["user", "toolResult"]) {
        await append([{ type: "image", url: imageUrl(role) }], role);
      }
      const all = page(await list());
      expect(all.artifacts.slice(0, 2).map((artifact) => artifact.image?.url)).toEqual([
        imageUrl("toolResult"),
        imageUrl("user"),
      ]);
      const filtered = page(await list({ messageRole: "assistant" }));
      expect(imageUrls(filtered)).toEqual(urls.toReversed().slice(0, 4));
      expectArtifactError(await list({ cursor: filtered.nextCursor }), "artifact_cursor_invalid");
      expectArtifactError(
        await list({ cursor: all.nextCursor, messageRole: "assistant" }),
        "artifact_cursor_invalid",
      );
      const remaining = page(await list({ cursor: filtered.nextCursor, messageRole: "assistant" }));
      expect(imageUrls(remaining)).toEqual(urls.slice(0, 2).toReversed());
      expect(remaining.nextCursor).toBeUndefined();
    });
  });

  it("pages newest images within one message and includes Markdown local images without reading files", async () => {
    await withImages(async () => {
      await append([{ type: "image", data: "aGVsbG8=", mimeType: "image/png", alt: "inline" }]);
      await append(
        imageUrlsFor(5).map((url, index) => ({ type: "image", url, alt: `image-${index}` })),
      );
      await append(
        "![Screenshot](/synthetic/nonexistent/screenshot.png)\n`![code](/private/code.png)`\n```md\n![fenced](/private/fenced.png)\n```",
      );
      const first = page(await list());
      expect(imageUrls(first)).toEqual([
        "/synthetic/nonexistent/screenshot.png",
        imageUrl(4),
        imageUrl(3),
        imageUrl(2),
      ]);
      expect(first.artifacts[0]?.download.mode).toBe("unsupported");
      await append([{ type: "image", url: imageUrl("new") }]);
      const second = page(await list({ cursor: first.nextCursor }));
      expect(imageUrls(second)).toEqual([
        imageUrl(1),
        imageUrl(0),
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

  it.each(["sparse", "oversized"] as const)(
    "bounds a %s image scan and continues from its cursor",
    async (kind) => {
      await withImages(async () => {
        const data =
          kind === "oversized" ? Buffer.alloc(1.5 * 1024 * 1024, 1).toString("base64") : undefined;
        await append([
          data
            ? { type: "image", data, mimeType: "image/png", title: "Screenshot" }
            : { type: "image", url: "https://images.example.test/old.png" },
        ]);
        for (let index = 0; index < (data ? 2 : 40); index++) {
          await append(`text-${index}`);
        }
        const first = page(await list());
        expect(first.artifacts).toEqual([]);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = page(
          await list({ cursor: expectDefined(first.nextCursor, "image cursor") }),
        );
        expect(second.artifacts).toHaveLength(1);
        expect(await list({ limit: 5 })).toMatchObject({ ok: false });
        expect(await list({ type: undefined, limit: 2 })).toMatchObject({ ok: false });
        if (data) {
          const image = expectDefined(second.artifacts[0], "inline image reference");
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
          expect(second).not.toHaveProperty("omittedOversized");
          expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThan(2 * 1024);
          expect(second.nextCursor).toBeUndefined();
          expect(await invoke("artifacts.download", { artifactId: image.id })).toMatchObject({
            ok: true,
            payload: { encoding: "base64", data },
          });
        } else {
          expect(second.artifacts[0]?.image?.url).toBe("https://images.example.test/old.png");
        }
      });
    },
  );

  it("bounds inline previews for images without transcript download references", async () => {
    await withImages(async () => {
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
    await withImages(async () => {
      await append(imageUrlsFor(6).map((url) => ({ type: "image", url })));
      const client = sharingPolicyClient({ user: "image-viewer", scopes: ["operator.read"] });
      const first = page(await list({}, client));
      const cursor = expectDefined(first.nextCursor, "image cursor");
      expectArtifactError(
        await list(
          { cursor },
          sharingPolicyClient({ user: "image-viewer", scopes: ["operator.read"] }),
        ),
        "artifact_cursor_invalid",
      );
      const other = { ...scope, sessionKey: "agent:main:other-images", sessionId: "other-images" };
      await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
      expectArtifactError(
        await list({ cursor, sessionKey: other.sessionKey }, client),
        "artifact_cursor_invalid",
      );
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
      expectArtifactError(await list({ cursor }, client), "artifact_cursor_invalid");
    });
  });
});

it("keeps an admitted run on its stored main row when the public alias becomes global", async () => {
  await withState(async (state) => {
    const source: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { research: {} } },
    };
    const initial = await configuredState(state, source);
    const runId = "qualified-main-run";
    const stored = sessionScope("qualified-main-window", "research", "agent:research:main");
    await seedMessage(
      stored,
      fileMessage("stored-main.txt", "aGVsbG8=", runId),
      undefined,
      Date.now(),
    );
    const admitted = expectDefined(
      await prepareAgentSession({
        cfg: initial,
        requestedSessionKey: stored.sessionKey,
        requestedSessionId: stored.sessionId,
        expectedExistingSessionId: stored.sessionId,
        request: { message: "stored address proof", idempotencyKey: runId },
        canUseCronRunContinuation: false,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        respond: () => {
          throw new Error("Expected session admission");
        },
      }),
      "admitted session",
    );
    expect(admitted.canonicalKey).toBe(stored.sessionKey);
    expect(admitted.canonicalSessionAgentId).toBe(stored.agentId);
    registerAgentRunContext(runId, {
      agentId: admitted.canonicalSessionAgentId,
      sessionKey: admitted.canonicalKey,
      sessionId: admitted.sessionId,
    });
    try {
      const globalSource: OpenClawConfig = { ...source, session: { scope: "global" } };
      const current = await configuredState(state, globalSource);
      const global = sessionScope("global-window", "research", "global");
      await seedMessage(global, fileMessage("global.txt", "Z2xvYmFs"), undefined, Date.now());
      const context = createDirectChatContext({ getRuntimeConfig: () => current });
      const client = sharingPolicyClient({ user: "artifact-viewer", scopes: ["operator.read"] });
      const query = (params: Record<string, unknown>) =>
        invoke("artifacts.list", params, client, context);
      expectArtifacts(await query({ sessionKey: stored.sessionKey }), [
        { title: "global.txt", sessionKey: "global" },
      ]);
      for (const agentId of [undefined, "research"]) {
        expectArtifacts(await query({ sessionKey: undefined, runId, agentId }), [
          { title: "stored-main.txt", sessionKey: stored.sessionKey, runId },
        ]);
      }
      await upsertSessionEntryCore(stored, {
        sessionId: stored.sessionId,
        updatedAt: Date.now(),
        visibility: "draft",
      });
      expectArtifactError(
        await query({ sessionKey: undefined, runId }),
        "artifact_scope_not_found",
      );
      expectArtifacts(await query({ sessionKey: stored.sessionKey }), [{ title: "global.txt" }]);
    } finally {
      clearAgentRunContext(runId);
    }
  });
});

it("keeps cached run owners and physical global namespaces in artifact queries", async () => {
  await withState(async (state) => {
    const sourceConfig: OpenClawConfig = {
      session: { scope: "global" },
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };
    const cfg = await configuredState(state, sourceConfig);
    const rawRunId = "research-run";
    const literalRunId = "research-literal-run";
    const raw = {
      ...sessionScope("research-raw-global", "research", "global"),
      runId: rawRunId,
      title: "raw-global.txt",
    };
    const literal = {
      ...sessionScope("research-literal-global", "research", "agent:research:global"),
      runId: literalRunId,
      title: "literal-qualified-global.txt",
    };
    for (const target of [raw, literal]) {
      await seedMessage(target, fileMessage(target.title, "aGVsbG8=", target.runId));
    }
    registerAgentRunContext(rawRunId, raw);
    registerAgentRunContext(literalRunId, literal);
    try {
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      for (const [params, target, control] of [
        [{ runId: rawRunId, agentId: "research" }, raw, true],
        [{ sessionKey: literal.sessionKey, agentId: "research" }, literal, true],
        [{ runId: rawRunId }, raw, false],
        [{ runId: literalRunId, agentId: "research" }, literal, false],
      ] as const) {
        const { title, sessionKey, runId } = target;
        const response = await invoke(
          "artifacts.list",
          { sessionKey: undefined, ...params },
          null,
          context,
        );
        expectArtifacts(response, [{ title, sessionKey, runId }], !control);
      }
    } finally {
      clearAgentRunContext(rawRunId);
      clearAgentRunContext(literalRunId);
    }
  });
});
describe("persisted chat image artifact recovery", () => {
  const transcriptScope = sessionScope("computer-images");

  function transcriptRpc(
    method: "chat.history" | "artifacts.get" | "artifacts.download",
    params: Record<string, unknown>,
    client: GatewayClient | null = null,
    context?: GatewayRequestContext,
  ) {
    return invoke(method, params, client, context, transcriptScope.sessionKey);
  }

  function imageIds(message: unknown): string[] {
    const content = asOptionalRecord(message)?.content;
    return Array.isArray(content)
      ? content.flatMap((block) => {
          const image = asOptionalRecord(block);
          if (image?.type !== "image") {
            return [];
          }
          expect(image).toMatchObject({ omitted: true, artifactId: expect.any(String) });
          expect(image).not.toHaveProperty("data");
          if (image.source) {
            expect(image.source).not.toHaveProperty("data");
          }
          return [String(image.artifactId)];
        })
      : [];
  }

  async function imageReference(target: typeof scope, messageId: string) {
    const { message } = await transcriptReaders.readSessionMessageByIdAsync(target, messageId);
    return expectDefined(
      imageIds(projectChatDisplayMessage(message))[0],
      "projected image reference",
    );
  }

  async function expectDownload(artifactId: string, data: string) {
    expect(await transcriptRpc("artifacts.download", { artifactId })).toMatchObject({
      ok: true,
      payload: { encoding: "base64", data },
    });
  }

  async function historyMessages() {
    const history = await transcriptRpc("chat.history", {}, null, await createHistoryReadContext());
    expect(history.ok).toBe(true);
    const messages = asOptionalRecord(history.payload)?.messages;
    expect(Array.isArray(messages)).toBe(true);
    return Array.isArray(messages) ? messages : [];
  }

  it("recovers each visible legacy image when transcript rows reuse a message id", async () => {
    await withState(async () => {
      await captureRuntimeConfigAsyncReader()();
      const images = ["Zmlyc3Q=", "c2Vjb25k"];
      await seedUnindexedTranscriptForTest({
        ...transcriptScope,
        entry: { sessionId: transcriptScope.sessionId, updatedAt: 1 },
        events: images.map((data, seq) => ({
          session_id: transcriptScope.sessionId,
          seq,
          created_at: seq,
          event_json: JSON.stringify({
            id: "reused-legacy-id",
            message: imageMessage(data, "toolResult"),
          }),
        })),
      });
      const ids = (await historyMessages()).flatMap(imageIds);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      const reads = observeSqliteReadSql(StatementSync.prototype);
      try {
        for (const [index, artifactId] of ids.entries()) {
          await expectDownload(artifactId, expectDefined(images[index], "legacy image bytes"));
        }
        expect(reads.queries.filter((sql) => /\btranscript_events\b/i.test(sql))).toEqual([]);
      } finally {
        reads.restore();
      }
    });
  });

  it("downloads the exact image bytes referenced by history and committed live messages", async () => {
    await withState(async () => {
      await captureRuntimeConfigAsyncReader()();
      await seedMessage(transcriptScope, imageMessage("b2xk"));
      const images = [Buffer.alloc(300 * 1024, 1).toString("base64"), "c2Vjb25k"];
      const message = {
        role: "toolResult",
        toolName: "computer",
        toolCallId: "screen",
        content: [
          { type: "text", text: "screenshot 1200x500" },
          null,
          { type: "image", data: images[0], mimeType: "image/jpeg" },
          { type: "text", text: "second screen" },
          { type: "image", source: { type: "base64", data: images[1], media_type: "image/png" } },
        ],
        details: { media: { outbound: false } },
      };
      const appended = await appendTranscriptMessage(transcriptScope, { message });
      const displayed = (await historyMessages()).find(
        (row) => asOptionalRecord(asOptionalRecord(row)?.["__openclaw"])?.id === appended.messageId,
      );
      const ids = imageIds(displayed);
      expect(ids).toHaveLength(2);
      const persisted = await transcriptReaders.readSessionMessageByIdAsync(
        transcriptScope,
        appended.messageId,
      );
      const metadata = asOptionalRecord(asOptionalRecord(persisted.message)?.["__openclaw"]);
      const live = projectSessionMessagePayload({
        message: persisted.message,
        sessionKey: transcriptScope.sessionKey,
        messageId: appended.messageId,
        messageSeq: persisted.seq,
        transcriptPosition: readTranscriptDisplayPosition(metadata?.transcriptPosition),
      });
      expect(imageIds(live.payload?.message)).toEqual(ids);
      expect(persisted.message).toMatchObject({
        content: message.content,
        details: message.details,
      });
      for (const [index, artifactId] of ids.entries()) {
        expect(await transcriptRpc("artifacts.get", { artifactId })).toMatchObject({
          ok: true,
          payload: { artifact: { id: artifactId, type: "image", download: { mode: "bytes" } } },
        });
        await expectDownload(artifactId, expectDefined(images[index], "image bytes"));
        expectArtifactError(
          await transcriptRpc("artifacts.download", {
            artifactId,
            messageRole: "assistant",
          }),
          "artifact_not_found",
        );
      }
      // An uncommitted tool event has no transcript identity to authorize a later fetch.
      expect(projectChatDisplayMessage(message)).not.toHaveProperty("content.2.artifactId");
    });
  });

  it("does not retarget references across sessions or replacement incarnations with the same message id", async () => {
    await withState(async () => {
      await captureRuntimeConfigAsyncReader()();
      const message = imageMessage("b3JpZ2luYWw=");
      await seedMessage(transcriptScope, message, "shared-message-id");
      const artifactId = await imageReference(transcriptScope, "shared-message-id");
      const other = sessionScope("other-images");
      await seedMessage(other, message, "shared-message-id");
      expectArtifactError(
        await transcriptRpc("artifacts.download", {
          sessionKey: other.sessionKey,
          artifactId,
        }),
        "artifact_not_found",
      );
      const replacement = { ...transcriptScope, sessionId: "replacement-images" };
      await seedMessage(replacement, message, "shared-message-id", 2);
      expectArtifactError(
        await transcriptRpc("artifacts.download", { artifactId }),
        "artifact_not_found",
      );
      const currentId = await imageReference(replacement, "shared-message-id");
      expect(currentId).not.toBe(artifactId);
      expect(await transcriptRpc("artifacts.download", { artifactId: currentId })).toMatchObject({
        ok: true,
        payload: { data: "b3JpZ2luYWw=" },
      });
    });
  });

  it.each([
    { phase: "read", revocation: "sharing" },
    { phase: "response", revocation: "sharing" },
    { phase: "read", revocation: "runtime policy" },
  ] as const)("rechecks $revocation after the $phase await", async ({ phase, revocation }) => {
    await withState(async () => {
      let config: OpenClawConfig = {};
      setRuntimeConfigSnapshot(config);
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const owner = ensureProfileForEmail("image-owner@example.test");
      const viewer = ensureProfileForEmail("image-viewer@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const entry = {
        sessionId: transcriptScope.sessionId,
        updatedAt: 1,
        createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
      };
      await upsertSessionEntryCore(transcriptScope, { ...entry, visibility: "shared" });
      const appended = await appendTranscriptMessage(transcriptScope, {
        message: imageMessage("cHJpdmF0ZQ=="),
      });
      const artifactId = await imageReference(transcriptScope, appended.messageId);
      const client = sharingPolicyClient({ user: viewer.id, scopes: ["operator.read"] });
      expect(
        await transcriptRpc("artifacts.download", { artifactId }, client, context),
      ).toMatchObject({
        ok: true,
      });
      const read = transcriptReaders.readSessionArtifacts;
      const lookup = transcriptImageArtifacts.findTranscriptImageArtifact;
      const revoke = async () => {
        if (revocation === "runtime policy") {
          config = {
            gateway: {
              roles: {
                ...expectDefined(rolePolicyConfig().gateway?.roles, "role policy"),
                default: "none",
              },
            },
          };
          return;
        }
        await upsertSessionEntryCore(transcriptScope, {
          ...entry,
          updatedAt: 2,
          visibility: "draft",
        });
      };
      const spy =
        phase === "read"
          ? vi
              .spyOn(transcriptReaders, "readSessionArtifacts")
              .mockImplementationOnce(async (readScope, query) => {
                const result = await read(readScope, query);
                await revoke();
                return result;
              })
          : vi
              .spyOn(transcriptImageArtifacts, "findTranscriptImageArtifact")
              .mockImplementationOnce(async (...args) => {
                const result = await lookup(...args);
                await revoke();
                return result;
              });
      try {
        const denied = await transcriptRpc("artifacts.download", { artifactId }, client, context);
        expect(denied).toMatchObject({ ok: false, payload: undefined });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
