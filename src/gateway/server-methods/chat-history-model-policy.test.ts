import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import {
  prepareOperatorModelPresentation,
  projectOperatorModelRead,
} from "../operator-model-presentation.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { SerializedJsonArray } from "../serialized-json.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import * as historyDelta from "./chat-history-delta.js";
import {
  historyPayload as response,
  historyRpc,
  seedHistorySession,
  withHistoryState,
} from "./chat-history-fixture.test-support.js";
import { handleChatHistoryRequest } from "./chat-history-handler.js";
import * as historyPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import { identifiedClient, sessionReadHandlers } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

const historicalModel = { modelProvider: "example", model: "historical" };
const allowedModel = { modelProvider: "example", model: "allowed" };
const activeHistorical = { activeModelProvider: "example", activeModel: "historical" };
const activeAllowed = { activeModelProvider: "example", activeModel: "allowed" };
const assistant = (model: string, content: string) => ({
  role: "assistant",
  provider: "example",
  model,
  content,
  stopReason: "stop",
});
const messageGet = expectDefined(chatMessageGetHandlers["chat.message.get"], "message handler");
const recentGet = expectDefined(sessionByKeyReadHandlers["sessions.get"], "recent handler");
const rosterGet = expectDefined(sessionReadHandlers["sessions.list"], "roster handler");

function expectModelHidden(value: unknown, provider = "modelProvider") {
  for (const key of [
    provider,
    "model",
    ...(provider === "modelProvider" ? ["contextBudgetStatus"] : []),
  ]) {
    expect(value).not.toHaveProperty(key);
  }
}

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
  setRuntimeConfigSnapshot(cfg);
  const client = identifiedClient(person.id);
  client.connect.scopes = ["operator.read"];
  const changeRole = (role: string) => {
    setUserProfileRole(person.id, role);
    invalidateOperatorRolePolicy(person.id);
  };
  const setPolicy = (config: OpenClawConfig, allow: string[], deny?: string[]) => {
    expectDefined(config.gateway?.roles?.definitions.reader, "reader role").modelPolicy = {
      sourceAgent: "main",
      allow,
      ...(deny ? { deny } : {}),
    };
  };
  return { cfg, client, person, changeRole, setPolicy };
}

function record(value: unknown) {
  return expectDefined(asOptionalRecord(value), "projected record");
}

function onlyRecord(value: unknown) {
  const rows = expectDefined(Array.isArray(value) ? value : undefined, "record list");
  expect(rows).toHaveLength(1);
  return record(rows[0]);
}

describe("historical model disclosure", () => {
  it("keeps unrestricted startup history encoded between restricted viewers", async () => {
    await withHistoryState(async () => {
      const f = fixture();
      f.setPolicy(f.cfg, ["example/allowed"]);
      const staff = ensureProfileForEmail("history-staff@example.test");
      setUserProfileRole(staff.id, "staff");
      const staffClient = identifiedClient(staff.id);
      const message = assistant("historical", "Synthetic transcript");
      const messages = new SerializedJsonArray(Buffer.from(JSON.stringify([message])));
      const materialize = vi.spyOn(messages, "materialize");
      const input = {
        messages,
        metadata: {
          swarmEnabled: false,
          models: [
            {
              id: "allowed",
              provider: "example",
              name: "Allowed",
              availableAccessPrograms: { cyber: ["standard", "daybreak_blue"] },
            },
          ],
        },
      } satisfies Parameters<typeof projectOperatorModelRead>[1];
      const context = { getRuntimeConfig: () => f.cfg, getCommittedRuntimeConfig: () => f.cfg };
      for (const client of [staffClient, f.client, staffClient, f.client, staffClient]) {
        materialize.mockClear();
        const result = projectOperatorModelRead({ context, client, agentId: "main" }, input);
        expect(result.metadata?.models?.[0]?.availableAccessPrograms?.cyber).toEqual(["standard"]);
        if (client === staffClient) {
          expect(result.messages).toBe(messages);
          expect(materialize).not.toHaveBeenCalled();
        } else {
          expect(onlyRecord(result.messages)).toMatchObject({ content: message.content });
          expectModelHidden(onlyRecord(result.messages), "provider");
          expect(materialize).toHaveBeenCalledOnce();
        }
      }
      expect(JSON.parse(Buffer.from(messages.bytes).toString())).toEqual([message]);
      materialize.mockRestore();
    });
  });

  it("skips worker deflation when model projection replaces the serialized history", async () => {
    await withHistoryState(async (state) => {
      const f = fixture();
      await state.writeConfig(f.cfg);
      setRuntimeConfigSnapshot(f.cfg);
      const scope = await seedHistorySession("projected-history-compression", {
        createdActor: { type: "human", source: "profile", id: f.person.id },
      });
      const content = "Synthetic projected history. ".repeat(512);
      await appendTranscriptMessage(scope, {
        eventId: "projected-history-reply",
        message: { role: "assistant", provider: "example", model: "allowed", content },
      });
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => f.cfg,
        getCommittedRuntimeConfig: () => f.cfg,
      });
      const rpc = historyRpc(context, scope.sessionKey);
      const read = vi.spyOn(historyPages, "readChatHistoryPage");
      try {
        for (const role of ["reader", "staff"] as const) {
          f.changeRole(role);
          const respond = await rpc(
            "chat.history",
            { maxChars: 20_000 },
            {
              client: f.client,
              acceptsSerializedJson: true,
              acceptsDeflatedSegments: true,
              req: { type: "req", id: role, method: "chat.history" },
            },
          );
          const page = await read.mock.results.at(-1)?.value;
          expect(Boolean(page?.encodedMessagesDeflate?.byteLength)).toBe(role === "staff");
          const payload = response(respond);
          const messages =
            payload.messages instanceof SerializedJsonArray
              ? payload.messages.materialize()
              : payload.messages;
          expect(onlyRecord(messages)).toMatchObject({ content });
        }
      } finally {
        read.mockRestore();
      }
    });
  });

  it("projects concrete tuples while preserving clearing facts, bookkeeping and content", async () => {
    await withHistoryState(async () => {
      const f = fixture();
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      prepareGatewayRecipientProfile(f.client);
      f.setPolicy(f.cfg, ["example/allowed*"], ["example/allowed-denied"]);
      setRuntimeConfigSnapshot(f.cfg);
      const project = expectDefined(
        prepareOperatorModelPresentation({ cfg: f.cfg, policyConfig: f.cfg, client: f.client }),
        "restricted presentation",
      );
      const deniedBudget = contextBudgetStatusFixture({ provider: "example", model: "historical" });
      const allowedBudget = contextBudgetStatusFixture({ provider: "example", model: "allowed" });
      for (const [row, expected] of [
        [{ ...historicalModel, ...activeAllowed }, activeAllowed],
        [{ ...allowedModel, ...activeHistorical }, allowedModel],
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
      const visibleMessage = {
        role: "assistant",
        content,
        __openclaw: { id: "reply", seq: 1 },
        openclawDeliveryMirror: { kind: "channel-final" },
      };
      const message = { ...visibleMessage, provider: "example", model: "historical" };
      const original = structuredClone(message);
      const projected = project.message(message);
      expect(projected).toEqual(visibleMessage);
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
      const visibleEnvelope = {
        sessionKey: "agent:main:history-policy",
        messageId: "reply",
        messageSeq: 1,
        activeModelProvider: null,
        activeModel: null,
        session: { key: "agent:main:history-policy" },
        message: visibleMessage,
      };
      const envelope = {
        ...visibleEnvelope,
        ...historicalModel,
        contextBudgetStatus: deniedBudget,
        session: {
          ...visibleEnvelope.session,
          ...historicalModel,
          contextBudgetStatus: deniedBudget,
        },
        message,
      };
      const payload = { kind: "delta", deltaCursor: "unchanged-cursor", messages: [envelope] };
      const before = structuredClone(payload);
      const context = { getRuntimeConfig: () => f.cfg, getCommittedRuntimeConfig: () => f.cfg };
      const read = <T extends Parameters<typeof projectOperatorModelRead>[1]>(input: T) =>
        projectOperatorModelRead({ context, client: f.client, agentId: "main" }, input);
      const result = read(payload);
      expect(result).toEqual({ ...payload, messages: [visibleEnvelope] });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        Buffer.byteLength(JSON.stringify(payload)),
      );
      expect(payload).toEqual(before);
      expect(
        read({ messages: new SerializedJsonArray(Buffer.from(JSON.stringify([message]))) })
          .messages,
      ).toEqual([projected]);
      f.changeRole("staff");
      expect(read(payload)).toBe(payload);
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
    await withHistoryState(async (state) => {
      const f = fixture();
      await state.writeConfig(f.cfg);
      setRuntimeConfigSnapshot(f.cfg);
      let committed = f.cfg;
      const budget = contextBudgetStatusFixture({
        provider: "example",
        model: "historical",
        sessionId: "history-policy",
      });
      const scope = await seedHistorySession("history-policy", {
        createdActor: { type: "human", source: "profile", id: f.person.id },
        providerOverride: "example",
        modelOverride: "historical",
        modelOverrideSource: "user",
        ...historicalModel,
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
      expect(initialPayload.sessionInfo).toMatchObject(historicalModel);
      expect(initialPayload.sessionInfo).toHaveProperty("contextBudgetStatus", budget);
      const cursor = expectDefined(
        typeof initialPayload.deltaCursor === "string" ? initialPayload.deltaCursor : undefined,
        "initial cursor",
      );
      const content = "Saved example/historical reply.";
      await appendTranscriptMessage(scope, {
        eventId: "history-policy-reply",
        message: assistant("historical", content),
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
            eventId: "successor",
            message: assistant("allowed", "Successor reply"),
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
      const held = async <T>(result: T | Promise<T>) => {
        const value = await result;
        await hold();
        return value;
      };
      let preparedDelta: Awaited<ReturnType<typeof historyDelta.readChatHistoryDelta>> | undefined;
      if (stage === "tail" || stage === "retained") {
        const read = historyPages.readChatHistoryPage;
        vi.spyOn(historyPages, "readChatHistoryPage").mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          expect(onlyRecord(result.messages)).toMatchObject({
            provider: "example",
            model: "historical",
          });
          return held(result);
        });
      } else if (stage === "delta read" || stage === "delta publication") {
        const read = historyDelta.readChatHistoryDelta;
        vi.spyOn(historyDelta, "readChatHistoryDelta").mockImplementationOnce(async (...args) => {
          preparedDelta = await read(...args);
          return stage === "delta read" ? held(preparedDelta) : preparedDelta;
        });
      } else if (stage === "exact message") {
        const read = transcriptReaders.readSessionMessageByIdAsync;
        vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync").mockImplementationOnce(
          (...args) => held(read(...args)),
        );
      } else if (stage === "roster") {
        const prepare = rows.prepareSelection.bind(rows);
        vi.spyOn(rows, "prepareSelection").mockImplementationOnce((...args) =>
          held(prepare(...args)),
        );
      }
      if (stage === "recent" || stage === "delta publication") {
        const prepare = rows.withPreparedExactRows.bind(rows);
        let preparations = 0;
        vi.spyOn(rows, "withPreparedExactRows").mockImplementation(async (...args) => {
          if (stage === "recent" ? ++preparations === 2 : preparedDelta) {
            await hold();
          }
          return prepare(...args);
        });
      }
      const respond = vi.fn<RespondFn>();
      const opts = { ...historyOptions, respond };
      const selected =
        stage === "exact message"
          ? {
              handler: messageGet,
              params: { sessionKey: scope.sessionKey, messageId: "history-policy-reply" },
            }
          : stage === "recent"
            ? { handler: recentGet, params: { key: scope.sessionKey, limit: 1 } }
            : stage === "roster"
              ? { handler: rosterGet, params: { agentId: "main" } }
              : undefined;
      const pending = selected
        ? selected.handler({ ...opts, params: selected.params })
        : handleChatHistoryRequest({
            ...opts,
            params: { ...opts.params, ...(stage.startsWith("delta") ? { cursor } : {}) },
            retainedTranscript: stage === "retained" ? { sessionId: scope.sessionId } : undefined,
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
          if (preparedDelta?.kind !== "delta") {
            throw new Error("Expected a prepared delta");
          }
          const envelope = onlyRecord(preparedDelta.messages);
          expect(envelope).toMatchObject({
            ...historicalModel,
            session: historicalModel,
            message: { provider: "example", model: "historical" },
          });
          expect(envelope).toHaveProperty("contextBudgetStatus", budget);
          expect(envelope.session).toHaveProperty("contextBudgetStatus", budget);
        }
        committed = structuredClone(f.cfg);
        f.setPolicy(committed, ["example/allowed"]);
        release.resolve();
        await pending;
        const payload = response(respond);
        if (stage === "retained") {
          expect(payload.sessionId).toBe(scope.sessionId);
        }
        if (stage === "roster") {
          const row = onlyRecord(payload.sessions);
          expect(row).toMatchObject({ key: scope.sessionKey, sessionId: scope.sessionId });
          expectModelHidden(row);
        } else {
          if (stage !== "exact message" && stage !== "recent") {
            expect(payload.sessionInfo).toMatchObject({
              key: scope.sessionKey,
              sessionId: currentSessionId,
            });
            expectModelHidden(payload.sessionInfo);
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
            expectModelHidden(message);
            expect(message.session).toMatchObject({ key: scope.sessionKey });
            expectModelHidden(message.session);
            expect(
              preparedDelta?.kind === "delta" ? preparedDelta.messages[0] : undefined,
            ).toHaveProperty("model", "historical");
            message = record(message.message);
          }
          expect(message).toMatchObject({ role: "assistant", content });
          expectModelHidden(message, "provider");
        }
        expect(loadSessionEntry(scope)).toEqual(savedEntry);
        expect(await loadTranscriptEvents(scope)).toEqual(savedTranscript);
      } finally {
        release.resolve();
        try {
          await pending;
        } finally {
          vi.restoreAllMocks();
        }
      }
    });
  });
});
