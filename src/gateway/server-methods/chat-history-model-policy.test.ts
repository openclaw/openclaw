import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  prepareOperatorModelPresentation,
  projectOperatorModelRead,
} from "../operator-model-presentation.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import * as historyDelta from "./chat-history-delta.js";
import { handleChatHistoryRequest } from "./chat-history-handler.js";
import * as historyPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import { identifiedClient, sessionReadHandlers } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

function fixture() {
  const person = ensureProfileForEmail("history-model-reader@example.test");
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: "example/allowed",
        models: { "example/allowed": {}, "example/historical": {} },
      },
      entries: { main: {} },
    },
    plugins: { enabled: false },
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: {
            agents: ["main"],
            scopes: ["operator.read"],
            sessions: { others: "view" },
            modelPolicy: { sourceAgent: "main", allow: ["example/*"] },
          },
          staff: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
        },
      },
    },
  };
  const client = identifiedClient(person.id);
  client.connect.scopes = ["operator.read"];
  return { cfg, client, person };
}

function record(value: unknown) {
  return expectDefined(asOptionalRecord(value), "projected record");
}

function response(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond.mock.calls).toHaveLength(1);
  expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0]?.[2])).toBe(true);
  return record(respond.mock.calls[0]?.[1]);
}

function onlyRecord(value: unknown) {
  const rows = expectDefined(Array.isArray(value) ? value : undefined, "record list");
  expect(rows).toHaveLength(1);
  return record(rows[0]);
}

describe("historical model disclosure", () => {
  it("projects concrete tuples while preserving clearing facts, bookkeeping and content", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      expectDefined(f.cfg.gateway?.roles?.definitions.reader, "reader role").modelPolicy = {
        sourceAgent: "main",
        allow: ["example/allowed*"],
        deny: ["example/allowed-denied"],
      };
      const project = expectDefined(
        prepareOperatorModelPresentation({ cfg: f.cfg, policyConfig: f.cfg, client: f.client }),
        "restricted presentation",
      );
      const deniedBudget = contextBudgetStatusFixture({
        provider: "example",
        model: "historical",
      });
      const allowedBudget = contextBudgetStatusFixture({ provider: "example", model: "allowed" });
      for (const [row, expected] of [
        [
          {
            modelProvider: "example",
            model: "historical",
            activeModelProvider: "example",
            activeModel: "allowed",
          },
          { activeModelProvider: "example", activeModel: "allowed" },
        ],
        [
          {
            modelProvider: "example",
            model: "allowed",
            activeModelProvider: "example",
            activeModel: "historical",
          },
          { modelProvider: "example", model: "allowed" },
        ],
        [{ modelProvider: "example" }, {}],
        [{ modelProvider: null, model: "historical" }, { modelProvider: null }],
        [{ modelProvider: undefined, model: "historical" }, { modelProvider: undefined }],
        [{ activeModelProvider: "example", activeModel: null }, { activeModel: null }],
        [
          { modelProvider: null, model: null, activeModelProvider: null, activeModel: null },
          { modelProvider: null, model: null, activeModelProvider: null, activeModel: null },
        ],
        [{}, {}],
        [{ contextBudgetStatus: deniedBudget }, {}],
        [{ contextBudgetStatus: allowedBudget }, { contextBudgetStatus: allowedBudget }],
        [{ contextBudgetStatus: null }, { contextBudgetStatus: null }],
      ] as const) {
        const original = structuredClone(row);
        expect(project.session(row)).toStrictEqual(expected);
        expect(row).toStrictEqual(original);
      }
      const content = [
        { type: "text", text: "example/historical is ordinary text" },
        { type: "toolCall", id: "tool", name: "inspect", arguments: { model: "historical" } },
      ];
      const message = {
        role: "assistant",
        provider: "example",
        model: "historical",
        content,
        __openclaw: { id: "reply", seq: 1 },
        openclawDeliveryMirror: { kind: "channel-final" },
      };
      const original = structuredClone(message);
      const projected = project.message(message);
      expect(projected).toEqual({
        role: "assistant",
        content,
        __openclaw: message["__openclaw"],
        openclawDeliveryMirror: message.openclawDeliveryMirror,
      });
      expect(record(projected).content).toBe(content);
      expect(message).toEqual(original);
      for (const model of ["allowed", "allowed-outside-configured-list"]) {
        const allowed = { ...message, model };
        expect(project.message(allowed)).toBe(allowed);
      }
      expect(project.message({ ...message, model: "allowed-denied" })).not.toHaveProperty("model");
      expect(project.message({ ...message, provider: null })).toMatchObject({ provider: null });
      for (const model of ["gateway-injected", "delivery-mirror"]) {
        const bookkeeping = { ...message, provider: "openclaw", model };
        expect(project.message(bookkeeping)).toBe(bookkeeping);
      }
      for (const role of ["user", "toolResult"]) {
        const other = { ...message, role };
        expect(project.message(other)).toBe(other);
      }
      const envelope = {
        sessionKey: "agent:main:history-policy",
        messageId: "reply",
        messageSeq: 1,
        modelProvider: "example",
        model: "historical",
        activeModelProvider: null,
        activeModel: null,
        contextBudgetStatus: deniedBudget,
        session: {
          key: "agent:main:history-policy",
          modelProvider: "example",
          model: "historical",
          contextBudgetStatus: deniedBudget,
        },
        message,
      };
      const payload = { kind: "delta", deltaCursor: "unchanged-cursor", messages: [envelope] };
      const before = structuredClone(payload);
      const context = { getRuntimeConfig: () => f.cfg, getCommittedRuntimeConfig: () => f.cfg };
      const result = projectOperatorModelRead(
        { context, client: f.client, agentId: "main" },
        payload,
      );
      expect(result).toEqual({
        kind: "delta",
        deltaCursor: "unchanged-cursor",
        messages: [
          {
            sessionKey: envelope.sessionKey,
            messageId: "reply",
            messageSeq: 1,
            activeModelProvider: null,
            activeModel: null,
            session: { key: envelope.sessionKey },
            message: projected,
          },
        ],
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        Buffer.byteLength(JSON.stringify(payload)),
      );
      expect(payload).toEqual(before);
      setUserProfileRole(f.person.id, "staff");
      invalidateOperatorRolePolicy(f.person.id);
      expect(
        projectOperatorModelRead({ context, client: f.client, agentId: "main" }, payload),
      ).toBe(payload);
    });
  });

  it.each([
    "tail",
    "delta read",
    "delta publication",
    "retained",
    "exact message",
    "recent",
    "roster",
  ] as const)("rechecks committed policy after the held %s boundary", async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = fixture();
      await state.writeConfig(f.cfg);
      let committed = f.cfg;
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:history-policy",
        sessionId: "history-policy",
      };
      const budget = contextBudgetStatusFixture({
        provider: "example",
        model: "historical",
        sessionId: scope.sessionId,
      });
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: f.person.id },
        providerOverride: "example",
        modelOverride: "historical",
        modelOverrideSource: "user",
        modelProvider: "example",
        model: "historical",
        agentHarnessId: "openclaw",
        contextTokens: 200_000,
        contextTokensSource: "runtime",
        contextBudgetStatus: budget,
      });
      await appendTranscriptMessage(scope, {
        eventId: "history-policy-input",
        message: { role: "user", content: "Synthetic history question" },
      });
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => f.cfg,
        getCommittedRuntimeConfig: () => committed,
      });
      const historyOptions = {
        params: { sessionKey: scope.sessionKey, limit: 1 },
        client: f.client,
        context,
        req: { type: "req" as const, id: "history-policy", method: "chat.history" },
        isWebchatConnect: () => false,
        method: "chat.history" as const,
      };
      const initial = vi.fn<RespondFn>();
      await handleChatHistoryRequest({ ...historyOptions, respond: initial });
      const initialPayload = response(initial);
      expect(initialPayload.sessionInfo).toMatchObject({
        modelProvider: "example",
        model: "historical",
      });
      expect(initialPayload.sessionInfo).toHaveProperty("contextBudgetStatus", budget);
      const cursor = expectDefined(
        typeof initialPayload.deltaCursor === "string" ? initialPayload.deltaCursor : undefined,
        "initial cursor",
      );
      const content = "Stored example/historical reply survives policy narrowing.";
      await appendTranscriptMessage(scope, {
        eventId: "history-policy-reply",
        message: {
          role: "assistant",
          provider: "example",
          model: "historical",
          content,
          stopReason: "stop",
        },
      });
      const currentSessionId = stage === "retained" ? "history-policy-successor" : scope.sessionId;
      if (stage === "retained") {
        await patchSessionEntryCore(scope, () => ({
          sessionId: currentSessionId,
          contextBudgetStatus: { ...budget, sessionId: currentSessionId },
        }));
        await appendTranscriptMessage(
          { ...scope, sessionId: currentSessionId },
          {
            eventId: "history-policy-successor-reply",
            message: {
              role: "assistant",
              provider: "example",
              model: "allowed",
              content: "The newer session must not replace retained history.",
              stopReason: "stop",
            },
          },
        );
      }
      const savedEntry = loadSessionEntry(scope);
      const savedTranscript = await loadTranscriptEvents(scope);
      const rows = expectDefined(getSessionRowProjection(context), "row owner");
      const ready = createDeferred();
      const release = createDeferred();
      const hold = async () => {
        ready.resolve();
        await release.promise;
      };
      const restores: Array<() => void> = [];
      let preparedDelta: Awaited<ReturnType<typeof historyDelta.readChatHistoryDelta>> | undefined;
      if (stage === "tail" || stage === "retained") {
        const read = historyPages.readChatHistoryPage;
        const spy = vi
          .spyOn(historyPages, "readChatHistoryPage")
          .mockImplementationOnce(async (...args) => {
            const result = await read(...args);
            expect(onlyRecord(result.messages)).toMatchObject({
              provider: "example",
              model: "historical",
            });
            await hold();
            return result;
          });
        restores.push(() => spy.mockRestore());
      } else if (stage === "delta read" || stage === "delta publication") {
        const read = historyDelta.readChatHistoryDelta;
        const spy = vi
          .spyOn(historyDelta, "readChatHistoryDelta")
          .mockImplementationOnce(async (...args) => {
            preparedDelta = await read(...args);
            if (stage === "delta read") {
              await hold();
            }
            return preparedDelta;
          });
        restores.push(() => spy.mockRestore());
        if (stage === "delta publication") {
          const prepare = rows.withPreparedExactRows.bind(rows);
          const publication = vi
            .spyOn(rows, "withPreparedExactRows")
            .mockImplementation(async (...args) => {
              if (preparedDelta) {
                await hold();
              }
              return prepare(...args);
            });
          restores.push(() => publication.mockRestore());
        }
      } else if (stage === "exact message") {
        const read = transcriptReaders.readSessionMessageByIdAsync;
        const spy = vi
          .spyOn(transcriptReaders, "readSessionMessageByIdAsync")
          .mockImplementationOnce(async (...args) => {
            const result = await read(...args);
            await hold();
            return result;
          });
        restores.push(() => spy.mockRestore());
      } else if (stage === "recent") {
        const prepare = rows.withPreparedExactRows.bind(rows);
        let preparations = 0;
        const spy = vi.spyOn(rows, "withPreparedExactRows").mockImplementation(async (...args) => {
          if (++preparations === 2) {
            await hold();
          }
          return prepare(...args);
        });
        restores.push(() => spy.mockRestore());
      } else {
        const prepare = rows.ensureMaterialized.bind(rows);
        const spy = vi.spyOn(rows, "ensureMaterialized").mockImplementationOnce(async () => {
          await prepare();
          await hold();
        });
        restores.push(() => spy.mockRestore());
      }
      const respond = vi.fn<RespondFn>();
      const opts = { ...historyOptions, respond };
      const pending =
        stage === "exact message"
          ? expectDefined(
              chatMessageGetHandlers["chat.message.get"],
              "message handler",
            )({
              ...opts,
              params: { sessionKey: scope.sessionKey, messageId: "history-policy-reply" },
            })
          : stage === "recent"
            ? expectDefined(
                sessionByKeyReadHandlers["sessions.get"],
                "recent handler",
              )({
                ...opts,
                params: { key: scope.sessionKey, limit: 1 },
              })
            : stage === "roster"
              ? expectDefined(
                  sessionReadHandlers["sessions.list"],
                  "roster handler",
                )({
                  ...opts,
                  params: { agentId: "main" },
                })
              : handleChatHistoryRequest({
                  ...opts,
                  params: {
                    sessionKey: scope.sessionKey,
                    limit: 1,
                    ...(stage.startsWith("delta") ? { cursor } : {}),
                  },
                  ...(stage === "retained"
                    ? {
                        retainedSessionId: scope.sessionId,
                      }
                    : {}),
                });
      try {
        await Promise.race([
          ready.promise,
          Promise.resolve(pending).then(() => {
            throw new Error("Read published before reaching the held boundary");
          }),
        ]);
        expect(respond).not.toHaveBeenCalled();
        if (stage.startsWith("delta")) {
          expect(preparedDelta?.kind).toBe("delta");
          if (preparedDelta?.kind !== "delta") {
            throw new Error("Expected a prepared delta");
          }
          const envelope = onlyRecord(preparedDelta.messages);
          expect(envelope).toMatchObject({
            modelProvider: "example",
            model: "historical",
            session: { modelProvider: "example", model: "historical" },
            message: { provider: "example", model: "historical" },
          });
          expect(envelope).toHaveProperty("contextBudgetStatus", budget);
          expect(envelope.session).toHaveProperty("contextBudgetStatus", budget);
        }
        committed = structuredClone(f.cfg);
        expectDefined(
          committed.gateway?.roles?.definitions.reader,
          "committed reader",
        ).modelPolicy = {
          sourceAgent: "main",
          allow: ["example/allowed"],
        };
        release.resolve();
        await pending;
        const payload = response(respond);
        if (stage === "retained") {
          expect(payload.sessionId).toBe(scope.sessionId);
        }
        if (stage === "roster") {
          const row = onlyRecord(payload.sessions);
          expect(row).toMatchObject({ key: scope.sessionKey, sessionId: scope.sessionId });
          expect(row).not.toHaveProperty("model");
          expect(row).not.toHaveProperty("modelProvider");
          expect(row).not.toHaveProperty("contextBudgetStatus");
        } else {
          if (stage !== "exact message" && stage !== "recent") {
            expect(payload.sessionInfo).toMatchObject({
              key: scope.sessionKey,
              sessionId: currentSessionId,
            });
            expect(payload.sessionInfo).not.toHaveProperty("model");
            expect(payload.sessionInfo).not.toHaveProperty("modelProvider");
            expect(payload.sessionInfo).not.toHaveProperty("contextBudgetStatus");
          }
          let message =
            stage === "exact message" ? record(payload.message) : onlyRecord(payload.messages);
          if (stage.startsWith("delta")) {
            expect(payload).toMatchObject({
              kind: "delta",
              deltaCursor: preparedDelta?.kind === "delta" ? preparedDelta.deltaCursor : undefined,
            });
            expect(message).toMatchObject({
              messageId: "history-policy-reply",
              sessionKey: scope.sessionKey,
            });
            expect(message).not.toHaveProperty("model");
            expect(message).not.toHaveProperty("modelProvider");
            expect(message).not.toHaveProperty("contextBudgetStatus");
            expect(message.session).toMatchObject({ key: scope.sessionKey });
            expect(message.session).not.toHaveProperty("model");
            expect(message.session).not.toHaveProperty("modelProvider");
            expect(message.session).not.toHaveProperty("contextBudgetStatus");
            expect(
              preparedDelta?.kind === "delta" ? preparedDelta.messages[0] : undefined,
            ).toHaveProperty("model", "historical");
            message = record(message.message);
          }
          expect(message).toMatchObject({ role: "assistant", content });
          expect(message).not.toHaveProperty("provider");
          expect(message).not.toHaveProperty("model");
        }
        expect(loadSessionEntry(scope)).toEqual(savedEntry);
        expect(await loadTranscriptEvents(scope)).toEqual(savedTranscript);
      } finally {
        release.resolve();
        try {
          await pending;
        } finally {
          for (const restore of restores.toReversed()) {
            restore();
          }
        }
      }
    });
  });
});
