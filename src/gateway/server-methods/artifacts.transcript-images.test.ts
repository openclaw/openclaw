import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { readTranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { rolePolicyConfig, sharingPolicyClient } from "../session-sharing.test-utils.js";
import { projectSessionMessagePayload } from "../session-transcript-message.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import * as transcriptImageArtifacts from "./artifacts-transcript-images.js";
import { artifactsHandlers } from "./artifacts.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandler } from "./types.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:computer-images",
  sessionId: "computer-images",
};

async function invoke(
  method: "chat.history" | "artifacts.get" | "artifacts.download",
  params: Record<string, unknown>,
  client: GatewayClient | null = null,
  context?: GatewayRequestContext,
) {
  const handler: GatewayRequestHandler = expectDefined(
    method === "chat.history" ? chatHistoryHandlers[method] : artifactsHandlers[method],
    "RPC handler",
  );
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await handler({
    params: { sessionKey: scope.sessionKey, ...params },
    context: context ?? createDirectChatContext(),
    req: { type: "req", id: method, method },
    client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
  });
  return expectDefined(result, "RPC response");
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

describe("persisted chat image artifact recovery", () => {
  it("recovers each visible legacy image when transcript rows reuse a message id", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const images = ["Zmlyc3Q=", "c2Vjb25k"];
      await seedUnindexedTranscriptForTest({
        ...scope,
        entry: { sessionId: scope.sessionId, updatedAt: 1 },
        events: images.map((data, seq) => ({
          session_id: scope.sessionId,
          seq,
          created_at: seq,
          event_json: JSON.stringify({
            id: "reused-legacy-id",
            message: {
              role: "toolResult",
              content: [{ type: "image", data, mimeType: "image/png" }],
            },
          }),
        })),
      });
      const context = await createHistoryReadContext();
      const history = await invoke("chat.history", {}, null, context);
      expect(history.ok).toBe(true);
      const messages = asOptionalRecord(history.payload)?.messages;
      expect(Array.isArray(messages)).toBe(true);
      const ids = Array.isArray(messages) ? messages.flatMap(imageIds) : [];
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      for (const [index, artifactId] of ids.entries()) {
        expect(await invoke("artifacts.download", { artifactId })).toMatchObject({
          ok: true,
          payload: { encoding: "base64", data: images[index] },
        });
      }
    });
  });

  it("downloads the exact image bytes referenced by history and committed live messages", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [{ type: "image", data: "b2xk", mimeType: "image/png" }],
        },
      });
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
      const appended = await appendTranscriptMessage(scope, { message });
      const context = await createHistoryReadContext();
      const history = await invoke("chat.history", {}, null, context);
      expect(history.ok).toBe(true);
      const messages = asOptionalRecord(history.payload)?.messages;
      expect(Array.isArray(messages)).toBe(true);
      const displayed = Array.isArray(messages)
        ? messages.find(
            (row) =>
              asOptionalRecord(asOptionalRecord(row)?.["__openclaw"])?.id === appended.messageId,
          )
        : undefined;
      const ids = imageIds(displayed);
      expect(ids).toHaveLength(2);
      const persisted = await transcriptReaders.readSessionMessageByIdAsync(
        scope,
        appended.messageId,
      );
      const metadata = asOptionalRecord(asOptionalRecord(persisted.message)?.["__openclaw"]);
      const live = projectSessionMessagePayload({
        message: persisted.message,
        sessionKey: scope.sessionKey,
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
        expect(await invoke("artifacts.get", { artifactId })).toMatchObject({
          ok: true,
          payload: { artifact: { id: artifactId, type: "image", download: { mode: "bytes" } } },
        });
        expect(await invoke("artifacts.download", { artifactId })).toMatchObject({
          ok: true,
          payload: { encoding: "base64", data: images[index] },
        });
        expect(
          await invoke("artifacts.download", { artifactId, messageRole: "assistant" }),
        ).toMatchObject({ ok: false, error: { details: { type: "artifact_not_found" } } });
      }
      // An uncommitted tool event has no transcript identity to authorize a later fetch.
      expect(projectChatDisplayMessage(message)).not.toHaveProperty("content.2.artifactId");
    });
  });

  it("does not retarget references across sessions or replacement incarnations with the same message id", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const message = {
        role: "assistant",
        content: [{ type: "image", data: "b3JpZ2luYWw=", mimeType: "image/png" }],
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, { eventId: "shared-message-id", message });
      const original = await transcriptReaders.readSessionMessageByIdAsync(
        scope,
        "shared-message-id",
      );
      const artifactId = expectDefined(
        imageIds(projectChatDisplayMessage(original.message))[0],
        "projected image reference",
      );
      const other = { ...scope, sessionKey: "agent:main:other-images", sessionId: "other-images" };
      await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(other, { eventId: "shared-message-id", message });
      expect(
        await invoke("artifacts.download", { sessionKey: other.sessionKey, artifactId }),
      ).toMatchObject({ ok: false, error: { details: { type: "artifact_not_found" } } });
      const replacement = { ...scope, sessionId: "replacement-images" };
      await upsertSessionEntryCore(replacement, { sessionId: replacement.sessionId, updatedAt: 2 });
      await appendTranscriptMessage(replacement, { eventId: "shared-message-id", message });
      expect(await invoke("artifacts.download", { artifactId })).toMatchObject({
        ok: false,
        error: { details: { type: "artifact_not_found" } },
      });
      const current = await transcriptReaders.readSessionMessageByIdAsync(
        replacement,
        "shared-message-id",
      );
      const currentId = expectDefined(
        imageIds(projectChatDisplayMessage(current.message))[0],
        "replacement reference",
      );
      expect(currentId).not.toBe(artifactId);
      expect(await invoke("artifacts.download", { artifactId: currentId })).toMatchObject({
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
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let config: OpenClawConfig = {};
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const owner = ensureProfileForEmail("image-owner@example.test");
      const viewer = ensureProfileForEmail("image-viewer@example.test");
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
      };
      await upsertSessionEntryCore(scope, { ...entry, visibility: "shared" });
      const appended = await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [{ type: "image", data: "cHJpdmF0ZQ==", mimeType: "image/png" }],
        },
      });
      const stored = await transcriptReaders.readSessionMessageByIdAsync(scope, appended.messageId);
      const artifactId = expectDefined(
        imageIds(projectChatDisplayMessage(stored.message))[0],
        "shared reference",
      );
      const client = sharingPolicyClient({ user: viewer.id, scopes: ["operator.read"] });
      expect(await invoke("artifacts.download", { artifactId }, client, context)).toMatchObject({
        ok: true,
      });
      const read = transcriptReaders.readSessionMessagesPageWithStatsAsync;
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
        await upsertSessionEntryCore(scope, { ...entry, updatedAt: 2, visibility: "draft" });
      };
      const spy =
        phase === "read"
          ? vi
              .spyOn(transcriptReaders, "readSessionMessagesPageWithStatsAsync")
              .mockImplementationOnce(async (...args) => {
                const result = await read(...args);
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
        const denied = await invoke("artifacts.download", { artifactId }, client, context);
        expect(denied.ok).toBe(false);
        expect(denied.payload).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
