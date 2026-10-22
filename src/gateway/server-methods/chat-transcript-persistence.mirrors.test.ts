import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  readSessionTranscriptWatermark,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionLifecycleRevisionExpectation } from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createGatewayMetadataCloseFixture } from "../server-close.metadata.test-support.js";
import {
  enrichAssistantTranscriptMediaForRun,
  rewriteAssistantTranscriptMessageByIdempotencyKey as rewriteByKey,
  rewriteAssistantTranscriptMessageByTurnIndexAndMedia as rewriteByTurn,
  rewriteSourceReplyTranscriptMirrors as rewriteMirrors,
} from "./chat-transcript-persistence.js";

const mediaUrl = "https://example.com/mirror.png";
const correctedText = "Corrected delivery.";
const content = [{ type: "text", text: correctedText }];
const mirror = {
  idempotencyKey: "delivery-key",
  metadata: { sessionKey: "agent:main:mirrors", text: "Original delivery." },
};
const request = {
  ...mirror,
  state: {
    broadcastContent: content,
    persistedContent: content,
    hasManagedOutgoingContent: false,
    backedManagedOutgoingContent: false,
  },
};

function withFixture<T>(
  run: (fixture: Awaited<ReturnType<typeof seed>>, value: T) => Promise<void>,
) {
  return (value: T) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      setRuntimeConfigSnapshot({});
      await run(await seed(env), value);
    });
}

async function seed(env: NodeJS.ProcessEnv) {
  const identity = {
    agentId: "main",
    sessionId: "mirror-session",
    sessionKey: "agent:main:mirrors",
    env,
  };
  await replaceSessionEntry(identity, { sessionId: identity.sessionId, updatedAt: 1 });
  const scope = { ...identity, storePath: openOpenClawAgentDatabase(identity).path };
  const append = (eventId: string, message: Record<string, unknown>) =>
    expect(appendTranscriptMessageSync(scope, { eventId, message })).toMatchObject({ ok: true });
  for (const eventId of ["earlier", "selected"]) {
    append(eventId, {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      idempotencyKey: eventId === "selected" ? mirror.idempotencyKey : "other-delivery-key",
      content: [{ type: "text", text: `Original delivery.\nMEDIA:${mediaUrl}` }],
    });
  }
  const snapshot = () => loadTranscriptEventsSync(scope);
  const initialGeneration = readSessionTranscriptWatermark(scope).generation;
  const keyed = (replacement = content) =>
    rewriteByKey({ scope, content: replacement, idempotencyKey: " delivery-key " });
  const source = () => rewriteMirrors({ scope, candidates: [mirror], requests: [request] });
  const indexed = (overrides: Partial<Parameters<typeof rewriteByTurn>[0]> = {}) =>
    rewriteByTurn({
      scope,
      content,
      afterSeq: 0,
      assistantMessageIndex: 2,
      expectedGeneration: initialGeneration,
      mediaUrls: [mediaUrl],
      rejectedMediaCount: 0,
      ...overrides,
    });
  return { scope, append, snapshot, keyed, source, indexed };
}

type Events = ReturnType<typeof loadTranscriptEventsSync>;
const unselected = (events: Events) =>
  events.filter((event) => !isRecord(event) || event.id !== "selected");
const selected = (events: Events) =>
  events.find((event) => isRecord(event) && event.id === "selected");
const authoritativeMessage = {
  role: "assistant",
  content: [{ type: "text", text: "New authoritative delivery." }],
};
const correctedMessage = {
  idempotencyKey: "delivery-key",
  openclawDisplayContent: expect.arrayContaining(content),
};
const replaceSelected = (events: Events) =>
  events.map((event) =>
    isRecord(event) && event.id === "selected"
      ? { ...event, message: authoritativeMessage }
      : event,
  );

// Run the interleaving once, at the first content read during preparation.
function contentOnRead(text: string, action: () => void) {
  let prepared = false;
  return {
    content: [
      {
        type: "text",
        get text() {
          if (!prepared) {
            prepared = true;
            action();
          }
          return text;
        },
      },
    ],
  };
}

describe("durable transcript mirror corrections", () => {
  it.each(["keyed", "source", "indexed"] as const)(
    "corrects the selected %s reply without caller-thread SQL",
    withFixture(async (fixture, kind: "keyed" | "source" | "indexed") => {
      const { agentId, env, storePath: path } = fixture.scope;
      const before = fixture.snapshot();
      const hostSql = observeHostDataSql();
      const retirementEntered = createDeferred();
      const releaseRetirement = createDeferred();
      let following: Promise<void> | undefined;
      const waitForWriter = () => {
        following ??= runOpenClawAgentWriteAdmission({ agentId, env, path }, () => {});
        retirementEntered.resolve();
        return Promise.race([following, releaseRetirement.promise]);
      };
      const close = vi.spyOn(historyLane.pool, "closeResources").mockImplementation(waitForWriter);
      const rotate = vi.spyOn(historyLane.pool, "rotate").mockImplementation(waitForWriter);
      const correcting = fixture[kind]();
      try {
        const result = await Promise.race([
          correcting,
          retirementEntered.promise.then(() => {
            throw new Error("Correction reader cleanup waits on its own queued writer");
          }),
        ]);
        expect(kind === "source" ? result : [result]).toMatchObject([{ messageId: "selected" }]);
        expect(hostSql.queries, `MAIN ${kind} SQL`).toEqual([]);
      } finally {
        releaseRetirement.resolve();
        await Promise.allSettled([correcting, following]);
        close.mockRestore();
        rotate.mockRestore();
        hostSql.restore();
      }
      const after = fixture.snapshot();
      expect(unselected(after)).toEqual(unselected(before));
      expect(after).toHaveLength(before.length);
      expect(selected(after)).toMatchObject({ message: correctedMessage });
      if (kind === "keyed") {
        await expect(fixture.keyed()).resolves.toEqual({ messageId: "selected" });
        expect(fixture.snapshot()).toEqual(after);
      }
    }),
  );

  it(
    "refuses a source mirror behind an unrelated active-tail message",
    withFixture(async ({ append, snapshot, source }) => {
      append("next-request", { role: "user", content: "A later turn." });
      const before = snapshot();
      await expect(source()).resolves.toEqual([]);
      expect(snapshot()).toEqual(before);
    }),
  );

  it(
    "requires the exact turn media, rejected count, and captured generation",
    withFixture(async ({ snapshot, indexed }) => {
      const before = snapshot();
      for (const overrides of [
        { mediaUrls: ["https://example.com/another.png"] },
        { rejectedMediaCount: 1 },
        { assistantMessageIndex: 3 },
        { expectedGeneration: "stale-generation" },
      ]) {
        await expect(indexed(overrides)).resolves.toBeNull();
      }
      expect(snapshot()).toEqual(before);
    }),
  );

  it(
    "reports refusal when indexed correction loses its source generation",
    withFixture(async ({ scope, snapshot, indexed }) => {
      const retained = replaceSelected(snapshot());
      const replacement = contentOnRead("Stale correction.", () => {
        expect(replaceTranscriptEventsSync(scope, retained)).toBe(true);
      });
      const result = await indexed({ content: replacement.content });
      expect(result).toBeNull();
      expect(snapshot()).toEqual(retained);
    }),
  );

  it(
    "retains an unrelated append during indexed correction",
    withFixture(async ({ append, snapshot, indexed }) => {
      let retained = snapshot();
      const replacement = contentOnRead(correctedText, () => {
        append("later", { role: "user", content: "Following turn." });
        retained = snapshot();
      });
      const result = await indexed({ content: replacement.content });
      expect(result).toMatchObject({ messageId: "selected", generation: expect.any(String) });
      const after = snapshot();
      expect(unselected(after)).toEqual(unselected(retained));
      expect(after).toHaveLength(retained.length);
      expect(after.find((event) => isRecord(event) && event.id === "later")).toMatchObject({
        message: { role: "user", content: "Following turn." },
      });
      expect(selected(after)).toMatchObject({ message: correctedMessage });
    }),
  );

  it.each(["rewrite", "revocation"] as const)(
    "rejects intervening %s during display preparation",
    withFixture(async ({ scope, snapshot, keyed }, change: "rewrite" | "revocation") => {
      let current = true;
      let retained = snapshot();
      const replacement = contentOnRead("Stale correction.", () => {
        if (change === "rewrite") {
          retained = replaceSelected(retained);
          expect(replaceTranscriptEventsSync(scope, retained)).toBe(true);
        } else {
          current = false;
        }
      });
      await expect(
        withSessionTranscriptWriteAssertion(
          scope,
          () => assert(current, "Delivery authority revoked"),
          () => keyed(replacement.content),
        ),
      ).rejects.toThrow(
        change === "rewrite"
          ? "SQLite transcript changed while preparing rewrite"
          : "Delivery authority revoked",
      );
      expect(snapshot()).toEqual(retained);
    }),
  );
});

it("settles an accepted correction across the Gateway close prelude before closing its database", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-mirror-correction-close");
  const entered = createDeferred();
  const release = createDeferred();
  const accepted = createDeferred();
  const prelude = createDeferred();
  let held: ReturnType<typeof patchSessionEntryCore> | undefined;
  let correcting: ReturnType<typeof rewriteByKey> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const { scope, keyed } = await seed(fixture.state.env);
    const database = openOpenClawAgentDatabase(scope);
    held = patchSessionEntryCore(
      scope,
      async () => {
        entered.resolve();
        await release.promise;
        return { label: "writer settled before correction" };
      },
      { skipMaintenance: true, workerGuard: {} },
    );
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, held, "Writer was not held"),
      signal,
    );
    let corrected = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "accepted-mirror-correction",
      delayMs: 0,
      async run() {
        // Invocation retains the read source; the held writer prevents persistence.
        correcting = keyed();
        accepted.resolve();
        await correcting;
        expect(database.db.isOpen).toBe(true);
        corrected = true;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(accepted.promise, signal);
    kernel.scheduler.signal.addEventListener("abort", () => prelude.resolve(), { once: true });
    closing = server.close({ reason: "accepted mirror correction close proof" });
    await withinTest(
      awaitGateBeforeSettlement(prelude.promise, closing, "Gateway skipped close prelude"),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(corrected).toBe(false);
    expect(database.db.isOpen).toBe(true);
    release.resolve();
    const [, result] = await withinTest(Promise.all([held, correcting, closing]), signal);
    expect(result).toEqual({ messageId: "selected" });
    expect(corrected).toBe(true);
    expect(database.db.isOpen).toBe(false);
    const reopened = new DatabaseSync(database.path, { readOnly: true });
    try {
      const row = reopened
        .prepare(
          "SELECT event_json FROM transcript_events WHERE session_id = ? AND json_extract(event_json, '$.id') = ?",
        )
        .get(scope.sessionId, "selected");
      assert(typeof row?.event_json === "string");
      expect(JSON.parse(row.event_json)).toMatchObject({ message: correctedMessage });
    } finally {
      reopened.close();
    }
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([held, correcting, closing]);
    await fixture.cleanup();
  }
});

const RUN_ID = "generated-media-completion";
const MESSAGE_ID = "completion-answer";
const caption = "Here are four options.";
const choice = "Pick 1, 2, 3, or 4.";
const warningText = "Synthetic attachment warning.";
const text = (value: string, textSignature?: string) => ({
  type: "text",
  text: value,
  ...(textSignature ? { textSignature } : {}),
});
type Content = Record<string, unknown>[];
const transcriptEvent = (eventId: string, role: string, blocks: Content, extra = {}) => ({
  eventId,
  message: { role, content: blocks, ...extra },
});
const assistant = (eventId: string, blocks: Content, runId = RUN_ID, extra = {}) =>
  transcriptEvent(eventId, "assistant", blocks, {
    stopReason: "stop",
    __openclaw: { runId },
    ...extra,
  });
function displayOrder(display: unknown[]) {
  return display.map((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? block.text.trim()
      : isRecord(block)
        ? block.type
        : undefined,
  );
}

async function withTranscriptFixture(
  lifecycleRevision: SessionLifecycleRevisionExpectation,
  run: (fixture: Awaited<ReturnType<typeof seedTranscript>>) => Promise<void>,
  singleText = false,
): Promise<void> {
  await withOpenClawTestState({ label: "generated-media-transcript" }, async (state) => {
    await run(await seedTranscript(state, lifecycleRevision, singleText));
  });
}

async function seedTranscript(
  state: OpenClawTestState,
  lifecycleRevision: SessionLifecycleRevisionExpectation,
  singleText: boolean,
) {
  setRuntimeConfigSnapshot({});
  const scope = {
    agentId: "main",
    sessionId: "media-session",
    sessionKey: "agent:main:generated-media",
    env: state.env,
  };
  await replaceSessionEntry(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    ...(lifecycleRevision === null ? {} : { lifecycleRevision }),
  });
  const generatedMediaUrl = state.statePath("media", "generated-sheet.png");
  const mediaBlock = {
    type: "image",
    artifactId: "artifact_managed_image_generated-sheet",
    url: "/api/chat/media/outgoing/agent%3Amain%3Agenerated-media/generated-sheet/full",
    alt: "generated-sheet.png",
    mimeType: "image/png",
  };
  const warning = text(warningText);
  const mediaGroup = singleText ? [mediaBlock, warning] : [mediaBlock];
  const messages = [
    assistant("older-answer", [text("An earlier answer.")], "older-run"),
    transcriptEvent("request", "user", [text("Make an avatar sheet.")]),
    assistant(
      "generation-tool-call",
      [
        text("Preparing the sheet.", "signed-progress"),
        { type: "toolCall", id: "generate-call", name: "image_generate", arguments: {} },
      ],
      RUN_ID,
      { stopReason: "toolUse" },
    ),
    transcriptEvent("generation-tool-result", "toolResult", [text("Generated one image.")], {
      toolCallId: "generate-call",
      toolName: "image_generate",
      __openclaw: { runId: RUN_ID },
    }),
    assistant(
      MESSAGE_ID,
      singleText
        ? [
            text(
              `[[reply_to_current]]\n${caption}\nMEDIA:${generatedMediaUrl}\nMEDIA:${generatedMediaUrl}\n${choice}`,
              JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
            ),
          ]
        : [
            { type: "thinking", thinking: "Synthetic reasoning.", thinkingSignature: "opaque" },
            text(`${caption}\n`, "signed-caption"),
            text(`MEDIA:${generatedMediaUrl}`, "signed-media"),
            text(`\n${choice}`, "signed-choice"),
          ],
      RUN_ID,
      { openclawDelivery: { replyToCurrent: true } },
    ),
    transcriptEvent("later-request", "user", [text("Show that sheet again.")]),
    assistant(
      "later-answer",
      [text(`The same sheet, in a later turn.\nMEDIA:${generatedMediaUrl}`)],
      "later-run",
    ),
  ];
  for (const [index, { eventId, message }] of messages.entries()) {
    const result = appendTranscriptMessageSync(scope, { eventId, message, now: 1_000 + index });
    expect(result).toMatchObject({ ok: true, value: { appended: true, messageId: eventId } });
  }
  const snapshot = () => {
    const database = openOpenClawAgentDatabase(scope);
    const rows = database.db
      .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(scope.sessionId)
      .map((row) => {
        assert(typeof row.seq === "number" && typeof row.event_json === "string");
        const event: unknown = JSON.parse(row.event_json);
        assert(isRecord(event));
        return { seq: row.seq, eventJson: row.event_json, event };
      });
    return { rows, watermark: readSessionTranscriptWatermark(scope) };
  };
  return {
    scope,
    snapshot,
    mediaBlock,
    enrich: (runId = RUN_ID) =>
      enrichAssistantTranscriptMediaForRun({
        scope,
        runId,
        expectedLifecycleRevision: lifecycleRevision,
        content: [text([caption, choice].join(singleText ? "\n" : "\n\n\n")), ...mediaGroup],
        mediaBySource: new Map([[generatedMediaUrl, mediaGroup]]),
        mediaUrls: [generatedMediaUrl],
      }),
  };
}

describe("generated-media transcript enrichment", () => {
  it.each([
    [null, false],
    ["initial-revision", false],
    ["initial-revision", true],
  ] as const)(
    "preserves signed captions, media order, warnings, and replay (revision=%s, singleText=%s)",
    async (revision, singleText) => {
      await withTranscriptFixture(
        revision,
        async ({ enrich, snapshot, mediaBlock }) => {
          const before = snapshot();
          await expect(enrich()).resolves.toEqual({ messageId: MESSAGE_ID });
          const after = snapshot();
          expect(after.rows).toHaveLength(before.rows.length);
          expect(after.watermark.maxSeq).toBe(before.watermark.maxSeq);
          expect(after.watermark.generation).not.toBe(before.watermark.generation);
          for (const [index, row] of before.rows.entries()) {
            const rewritten = after.rows[index];
            if (row.event.id !== MESSAGE_ID) {
              expect(rewritten).toEqual(row);
              continue;
            }
            assert(rewritten && isRecord(row.event.message) && isRecord(rewritten.event.message));
            const { message: _originalMessage, ...originalEnvelope } = row.event;
            const { message: _rewrittenMessage, ...rewrittenEnvelope } = rewritten.event;
            expect(rewritten.seq).toBe(row.seq);
            expect(rewrittenEnvelope).toEqual(originalEnvelope);
            expect(rewritten.event.message.content).toEqual(row.event.message.content);
            expect(rewritten.event.message.openclawDelivery).toMatchObject({
              replyToCurrent: true,
            });
            const display = rewritten.event.message.openclawDisplayContent;
            assert(Array.isArray(display));
            expect(display.filter((block) => isRecord(block) && block.type === "image")).toEqual([
              mediaBlock,
            ]);
            expect(
              displayOrder(display.filter((block) => isRecord(block) && block.type !== "thinking")),
            ).toEqual([caption, "image", ...(singleText ? [warningText] : []), choice]);
          }

          await expect(enrich()).resolves.toEqual({ messageId: MESSAGE_ID });
          expect(snapshot()).toEqual(after);
        },
        singleText,
      );
    },
  );

  it("leaves the transcript unchanged when the requested run has no assistant reply", async () => {
    await withTranscriptFixture("initial-revision", async ({ enrich, snapshot }) => {
      const before = snapshot();
      await expect(enrich("missing-run")).resolves.toBeNull();
      expect(snapshot()).toEqual(before);
    });
  });

  it.each([
    ["session replacement", "initial-revision", "replacement-session", "initial-revision"],
    ["same-session revision change", "initial-revision", "media-session", "replacement-revision"],
    ["previously absent revision", null, "media-session", "replacement-revision"],
  ] as const)(
    "rejects stale media after %s",
    async (_label, captured, sessionId, lifecycleRevision) => {
      await withTranscriptFixture(captured, async ({ scope, enrich, snapshot }) => {
        await replaceSessionEntry(scope, { sessionId, lifecycleRevision, updatedAt: 2 });
        const before = snapshot();
        await expect(enrich()).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
        expect(snapshot()).toEqual(before);
      });
    },
  );
});
