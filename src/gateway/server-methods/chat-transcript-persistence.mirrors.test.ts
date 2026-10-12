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
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayMetadataCloseFixture } from "../server-close.metadata.test-support.js";
import {
  rewriteAssistantTranscriptMessageByIdempotencyKey,
  rewriteAssistantTranscriptMessageByIdAndMedia,
  rewriteSourceReplyTranscriptMirrors,
} from "./chat-transcript-persistence.js";

const mediaUrl = "https://example.com/mirror.png";
const content = [{ type: "text", text: "Corrected delivery." }];
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

async function withFixture(
  run: (fixture: Awaited<ReturnType<typeof seed>>) => Promise<void>,
  incognito = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) =>
    run(await seed(env, incognito)),
  );
}

async function seed(
  env: NodeJS.ProcessEnv,
  incognito = false,
  shared?: { agentId: string; storePath: string },
) {
  const agentId = shared?.agentId ?? "main";
  const storePath =
    shared?.storePath ??
    (incognito ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }) : undefined);
  if (shared) {
    openOpenClawAgentDatabase({ agentId: "main", path: storePath, env });
  }
  const identity = {
    agentId,
    sessionId: "mirror-session",
    sessionKey: incognito
      ? `agent:${agentId}:dashboard:incognito-mirrors`
      : `agent:${agentId}:mirrors`,
    storePath,
    env,
  };
  await replaceSessionEntry(identity, {
    sessionId: identity.sessionId,
    updatedAt: 1,
    ...(incognito ? { incognito: true as const } : {}),
  });
  const scope = {
    ...identity,
    storePath: openOpenClawAgentDatabase({ ...identity, agentId: "main", path: storePath }).path,
  };
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
    rewriteAssistantTranscriptMessageByIdempotencyKey({
      scope,
      content: replacement,
      idempotencyKey: " delivery-key ",
    });
  const source = () =>
    rewriteSourceReplyTranscriptMirrors({ scope, candidates: [mirror], requests: [request] });
  const indexed = (
    overrides: Partial<Parameters<typeof rewriteAssistantTranscriptMessageByIdAndMedia>[0]> = {},
  ) =>
    rewriteAssistantTranscriptMessageByIdAndMedia({
      scope,
      content,
      afterSeq: 0,
      messageId: "selected",
      expectedGeneration: initialGeneration,
      mediaUrls: [mediaUrl],
      rejectedMediaCount: 0,
      ...overrides,
    });
  return { scope, append, snapshot, keyed, source, indexed };
}

describe("durable transcript mirror corrections", () => {
  it.each(["keyed", "source", "indexed"] as const)(
    "corrects the selected %s reply without caller-thread SQL",
    async (kind) => {
      await withFixture(async (fixture) => {
        const before = fixture.snapshot();
        const hostSql = observeHostDataSql();
        const retirementEntered = createDeferred();
        const releaseRetirement = createDeferred();
        let following: Promise<void> | undefined;
        const waitForWriter = () => {
          following ??= runOpenClawAgentWriteAdmission(
            {
              agentId: fixture.scope.agentId,
              env: fixture.scope.env,
              path: fixture.scope.storePath,
            },
            () => {},
          );
          retirementEntered.resolve();
          return Promise.race([following, releaseRetirement.promise]);
        };
        const close = vi
          .spyOn(historyLane.pool, "closeResources")
          .mockImplementation(waitForWriter);
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
          const executions = hostSql.calls
            .slice(1)
            .reduce((count, call) => count + call.mock.calls.length, 0);
          expect(hostSql.queries, `MAIN ${kind}: ${executions} SQL executions`).toEqual([]);
        } finally {
          releaseRetirement.resolve();
          await Promise.allSettled([correcting, following]);
          close.mockRestore();
          rotate.mockRestore();
          hostSql.restore();
        }
        const after = fixture.snapshot();
        const unselected = (events: typeof before) =>
          events.filter((event) => !isRecord(event) || event.id !== "selected");
        expect(unselected(after)).toEqual(unselected(before));
        expect(after).toHaveLength(before.length);
        expect(after.find((event) => isRecord(event) && event.id === "selected")).toMatchObject({
          message: {
            idempotencyKey: "delivery-key",
            openclawDisplayContent: expect.arrayContaining(
              kind === "indexed" ? [{ type: "text", text: "Original delivery." }] : content,
            ),
          },
        });
        if (kind === "keyed") {
          await expect(fixture.keyed()).resolves.toEqual({ messageId: "selected" });
          expect(fixture.snapshot()).toEqual(after);
        }
      });
    },
  );

  it("refuses a source mirror behind an unrelated active-tail message", async () => {
    await withFixture(async ({ append, snapshot, source }) => {
      append("next-request", { role: "user", content: "A later turn." });
      const before = snapshot();
      await expect(source()).resolves.toEqual([]);
      expect(snapshot()).toEqual(before);
    });
  });

  it("requires the exact turn media, rejected count, and captured generation", async () => {
    await withFixture(async ({ snapshot, indexed }) => {
      const before = snapshot();
      for (const overrides of [
        { mediaUrls: ["https://example.com/another.png"] },
        { rejectedMediaCount: 1 },
        { messageId: "missing" },
        { expectedGeneration: "stale-generation" },
      ]) {
        await expect(indexed(overrides)).resolves.toBeNull();
      }
      expect(snapshot()).toEqual(before);
    });
  });

  it("preserves distinct signed completions while enriching exactly the receipted row", async () => {
    await withFixture(async ({ append, snapshot, indexed }) => {
      for (const messageId of ["first-response", "later-response"]) {
        append(messageId, {
          role: "assistant",
          responseId: messageId,
          content: [
            {
              type: "text",
              text: `Identical answer.\nMEDIA:${mediaUrl}`,
              textSignature: JSON.stringify({ v: 1, id: messageId, phase: "final_answer" }),
            },
          ],
        });
      }
      const before = snapshot();
      await expect(
        indexed({
          messageId: "later-response",
          content: [
            { type: "text", text: "answer tail" },
            { type: "image", url: "/managed/image" },
          ],
        }),
      ).resolves.toMatchObject({ messageId: "later-response" });
      const after = snapshot();
      expect(after).toHaveLength(before.length);
      for (const [index, original] of before.entries()) {
        const updated = after[index];
        if (!isRecord(original) || original.id !== "later-response") {
          expect(updated).toEqual(original);
          continue;
        }
        if (!isRecord(original.message)) {
          throw new Error("Expected canonical assistant fixture message");
        }
        expect(updated).toMatchObject({
          message: {
            responseId: "later-response",
            content: original.message.content,
            openclawDisplayContent: [
              { type: "text", text: "Identical answer." },
              { type: "image", url: "/managed/image" },
            ],
          },
        });
      }
    });
  });

  it.each([false])(
    "reports refusal when indexed correction loses its source generation (incognito=%s)",
    async (incognito) => {
      await withFixture(async ({ scope, snapshot, indexed }) => {
        const retained = snapshot().map((event) =>
          isRecord(event) && event.id === "selected"
            ? Object.assign({}, event, {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "New authoritative delivery." }],
                },
              })
            : event,
        );
        let replaced = false;
        const result = await indexed({
          content: [
            {
              type: "image",
              get alt() {
                if (!replaced) {
                  replaced = true;
                  expect(replaceTranscriptEventsSync(scope, retained)).toBe(true);
                }
                return "Stale correction.";
              },
            },
          ],
        });
        expect(replaced).toBe(true);
        expect(result).toBeNull();
        expect(snapshot()).toEqual(retained);
      }, incognito);
    },
  );

  it.each([false])(
    "retains an unrelated append during indexed correction (incognito=%s)",
    async (incognito) => {
      await withFixture(async ({ append, snapshot, indexed }) => {
        let retained = snapshot();
        let appended = false;
        const result = await indexed({
          content: [
            {
              type: "image",
              get alt() {
                if (!appended) {
                  appended = true;
                  append("later", { role: "user", content: "Following turn." });
                  retained = snapshot();
                }
                return "Corrected indexed delivery.";
              },
            },
          ],
        });
        expect(appended).toBe(true);
        expect(result).toMatchObject({ messageId: "selected", generation: expect.any(String) });
        const after = snapshot();
        const unselected = (events: typeof retained) =>
          events.filter((event) => !isRecord(event) || event.id !== "selected");
        expect(unselected(after)).toEqual(unselected(retained));
        expect(after).toHaveLength(retained.length);
        expect(after.find((event) => isRecord(event) && event.id === "later")).toMatchObject({
          message: { role: "user", content: "Following turn." },
        });
        expect(after.find((event) => isRecord(event) && event.id === "selected")).toMatchObject({
          message: {
            openclawDisplayContent: expect.arrayContaining([
              { type: "image", alt: "Corrected indexed delivery." },
            ]),
          },
        });
      }, incognito);
    },
  );

  it.each(["rewrite", "revocation"] as const)(
    "rejects intervening %s during display preparation",
    async (change) => {
      await withFixture(async ({ scope, snapshot, keyed }) => {
        let current = true;
        let prepared = false;
        let retained = snapshot();
        const replacement = [
          {
            type: "text",
            get text() {
              if (!prepared) {
                prepared = true;
                if (change === "rewrite") {
                  retained = retained.map((event) =>
                    isRecord(event) && event.id === "selected"
                      ? {
                          ...event,
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "New authoritative delivery." }],
                          },
                        }
                      : event,
                  );
                  expect(replaceTranscriptEventsSync(scope, retained)).toBe(true);
                } else {
                  current = false;
                }
              }
              return "Stale correction.";
            },
          },
        ];
        await expect(
          withSessionTranscriptWriteAssertion(
            scope,
            () => {
              if (!current) {
                throw new Error("Delivery authority revoked");
              }
            },
            () => keyed(replacement),
          ),
        ).rejects.toThrow(
          change === "rewrite"
            ? "SQLite transcript changed while preparing rewrite"
            : "Delivery authority revoked",
        );
        expect(prepared).toBe(true);
        expect(snapshot()).toEqual(retained);
      });
    },
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
  let correcting: ReturnType<typeof rewriteAssistantTranscriptMessageByIdempotencyKey> | undefined;
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
      expect(JSON.parse(row.event_json)).toMatchObject({
        message: {
          idempotencyKey: "delivery-key",
          openclawDisplayContent: expect.arrayContaining(content),
        },
      });
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
