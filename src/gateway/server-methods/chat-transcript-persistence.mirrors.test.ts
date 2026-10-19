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
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayMetadataCloseFixture } from "../server-close.metadata.test-support.js";
import {
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
  const prepare = vi.fn(action);
  return {
    prepare,
    content: [
      {
        type: "text",
        get text() {
          if (!prepared) {
            prepared = true;
            prepare();
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
      expect(replacement.prepare).toHaveBeenCalledOnce();
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
      expect(replacement.prepare).toHaveBeenCalledOnce();
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
      expect(replacement.prepare).toHaveBeenCalledOnce();
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
