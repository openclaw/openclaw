import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import {
  cfg,
  messageCutContext,
  seedMessageCutSource,
  useMessageCutStorageFixture,
} from "./sessions-rewind.storage.test-support.js";

useMessageCutStorageFixture();

const images = Array.from({ length: 5 }, (_, index) => ({
  data: Buffer.from("synthetic-image-" + (index + 1)).toString("base64"),
  path: "/synthetic/inbound/image-" + (index + 1) + ".png",
}));

function imageTurn(count: number) {
  const retained = images.slice(0, count);
  return {
    role: "user" as const,
    timestamp: 1,
    content: [
      { type: "text" as const, text: "Compare these " + count + " images." },
      ...retained.map(({ data }) => ({ type: "image" as const, data, mimeType: "image/png" })),
    ],
    __openclaw: {
      media: retained.map(({ path }) => ({ path, contentType: "image/png" })),
    },
  };
}

async function modelContext(scope: Parameters<typeof SessionManager.openModelContextAsync>[0]) {
  const manager = await SessionManager.openModelContextAsync(scope);
  return convertToLlm(manager.buildSessionContext().messages);
}

function contextImages(messages: Awaited<ReturnType<typeof modelContext>>) {
  return {
    inline: messages.flatMap((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? message.content.flatMap((block) => (block.type === "image" ? [block.data] : []))
        : [],
    ),
    persisted: messages.flatMap((message) =>
      (readPersistedMediaFacts(message) ?? []).map((media) => media.path),
    ),
  };
}

it("excludes the persisted rejected image branch from model context after rewind and resend", async () => {
  await withOpenClawTestState({ label: "rewind-image-context" }, async (state) => {
    await state.writeConfig(cfg);
    const source = await seedMessageCutSource();
    const scope = { ...source, storePath: resolveOpenClawAgentSqlitePath(source) };
    const original = await SessionManager.openAsync(scope);
    const rejectedId = await original.appendMessageAsync(imageTurn(5));

    // Reopen through the actual model-context reader, not the writer's local view.
    expect(contextImages(await modelContext(scope))).toEqual({
      inline: images.map(({ data }) => data),
      persisted: images.map(({ path }) => path),
    });

    const params = { sessionKey: scope.sessionKey, entryId: rejectedId };
    const respond = vi.fn();
    await expectDefined(
      sessionRewindHandlers["sessions.rewind"],
      "rewind handler",
    )({
      req: { type: "req", id: "rewind-rejected-images", method: "sessions.rewind", params },
      params,
      respond,
      context: messageCutContext(),
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    const entry = expectDefined(await readSessionEntryReadOnlyInWorker(scope), "rewound session");
    expect(entry.sessionId).not.toBe(scope.sessionId);
    const rewoundScope = { ...scope, sessionId: entry.sessionId };
    expect(contextImages(await modelContext(rewoundScope))).toEqual({
      inline: [],
      persisted: [],
    });

    // Normal session-manager append, with no selected-parent override: resend must
    // inherit the rewound leaf rather than the rejected five-image turn.
    const resend = await SessionManager.openAsync(rewoundScope);
    await resend.appendMessageAsync(imageTurn(4));
    const context = await modelContext(rewoundScope);
    expect(contextImages(context)).toEqual({
      inline: images.slice(0, 4).map(({ data }) => data),
      persisted: images.slice(0, 4).map(({ path }) => path),
    });
    expect(
      context.filter((message) => message.role === "user").map((message) => message.content),
    ).toEqual(["Remember lighthouse.", "What did I say?", imageTurn(4).content]);

    // The rejected event remains durable as an inactive branch. The context
    // assertion above therefore cannot pass merely because history was deleted.
    expect(await loadTranscriptEvents(rewoundScope)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: rejectedId })]),
    );
  });
});
