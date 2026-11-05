/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import { buildWorkboardMocks } from "./control-ui-workboard-fixtures.ts";
import { sessionClient } from "./session-gateway-client.test-support.ts";

const notes = { key: "agent:ops:notes", sessionId: "notes-generation-1", label: "Notes" };

it("serves requested initial history through the startup response owner", async ({ connect }) => {
  const messages = [{ role: "assistant", content: "Cached conversation" }];
  const client = sessionClient(
    await connect({ sessions: [notes], sessionTranscripts: { [notes.key]: { messages } } }),
    notes.key,
  );
  const subscribe = (initialHistory?: Record<string, unknown>) =>
    client.payload("sessions.messages.subscribe", { key: notes.key, initialHistory });
  expect(await subscribe()).not.toHaveProperty("initialHistory");
  expect(await subscribe({})).toMatchObject({
    key: notes.key,
    initialHistory: {
      ok: true,
      payload: { messages, sessionId: notes.sessionId, sessionInfo: notes },
    },
  });
  const delta = { kind: "delta", deltaCursor: "next", messages: [] };
  client.controls.setMethodResponse("chat.startup", {
    cases: [{ match: { sessionKey: notes.key, cursor: "cached" }, response: delta }],
  });
  expect(await subscribe({ cursor: "cached" })).toMatchObject({
    initialHistory: { ok: true, payload: delta },
  });
  const error = { code: "UNAVAILABLE", message: "History is not ready", retryable: true };
  client.controls.setMethodResponse("chat.startup", { __mockError: error });
  expect(
    await client.request("sessions.messages.subscribe", { key: notes.key, initialHistory: {} }),
  ).toMatchObject({ ok: true, payload: { initialHistory: { ok: false, error } } });
});

it("omits initial history only when the scenario explicitly exercises the fallback", async ({
  connect,
}) => {
  const client = sessionClient(await connect({ subscriptionInitialHistory: false }), notes.key);
  expect(
    await client.payload("sessions.messages.subscribe", { key: notes.key, initialHistory: {} }),
  ).not.toHaveProperty("initialHistory");
});

it("preserves stale wire responses without consuming sequences or replacing canonical identity", async ({
  connect,
}) => {
  const stale = { ...notes, sessionId: "retired-generation", pinned: false };
  const firstList = { sessions: [stale], offset: 10 };
  const lastList = { sessions: [], offset: 20 };
  const transcript = { messages: [], sessionId: "retired-transcript", sessionInfo: stale };
  const connection = await connect({
    sessions: [notes],
    methodResponses: {
      "sessions.list": { sequence: [firstList, lastList] },
      "chat.history": {
        cases: [{ match: { sessionKey: notes.key, offset: 10 }, response: transcript }],
      },
    },
  });
  const client = sessionClient(connection, notes.key);
  const { controls, send, response } = client;
  expect((await client.transcript("chat.history")).sessionId).toBe(notes.sessionId);
  expect((await client.transcript()).sessionId).toBe(notes.sessionId);
  expect(await client.payload("sessions.list")).toMatchObject(firstList);
  expect(await client.payload("sessions.list")).toEqual(lastList);
  expect(await client.payload("sessions.list")).toEqual(lastList);
  expect(await client.transcript("chat.history", { offset: 10 })).toEqual(transcript);
  controls.deferNext("chat.startup");
  const id = await send("chat.startup", { sessionKey: notes.key });
  controls.resolveDeferred("chat.startup", transcript);
  expect(response(id)?.payload).toEqual(transcript);
  controls.setMethodResponse("chat.history", transcript);
  expect(await client.transcript("chat.history")).toEqual(transcript);
  expect(await client.transcript()).toMatchObject(transcript);
  expect(await client.session()).toMatchObject(notes);
});

it("does not commit rejected patches or unresolved deferrals", async ({ connect }) => {
  const client = sessionClient(await connect({ sessionKey: notes.key }), notes.key);
  const { send, response, controls } = client;
  controls.setMethodResponse("sessions.patch", {
    __mockError: { code: "INVALID_REQUEST", message: "rejected" },
  });
  expect(await client.patch({ pinned: true })).toMatchObject({ ok: false });
  expect(await client.rows()).toMatchObject([{ pinned: false }]);
  controls.setMethodResponse("sessions.patch", { ok: true });
  controls.deferNext("sessions.patch");
  const pending = await send("sessions.patch", { key: notes.key, pinned: true });
  expect(response(pending)).toBeUndefined();
  expect(await client.rows()).toMatchObject([{ pinned: false }]);
  controls.rejectDeferred("sessions.patch");
  expect(await client.rows()).toMatchObject([{ pinned: false }]);
  controls.deferNext("sessions.patch");
  await send("sessions.patch", { key: notes.key, pinned: true });
  controls.resolveDeferred("sessions.patch", { ok: true });
  expect(await client.rows()).toMatchObject([{ pinned: true, pinnedAt: expect.any(Number) }]);
  const beforeStalePatch = await client.rows();
  expect(
    await client.patch({ expectedSessionId: "retired-generation", label: "Wrong generation" }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(await client.rows()).toEqual(beforeStalePatch);
  const replacement = { ...notes, sessionId: "replacement-generation", label: "Replacement label" };
  controls.setSessionsListResponse({ sessions: [{ ...notes, sessionId: replacement.sessionId }] });
  expect(
    await client.patch({ expectedSessionId: replacement.sessionId, label: replacement.label }),
  ).toMatchObject({ ok: true });
  expect(await client.rows()).toMatchObject([replacement]);
  for (const method of ["sessions.describe", "sessions.dispatch", "chat.history", "chat.startup"]) {
    const params = method.startsWith("sessions.") ? { key: notes.key } : { sessionKey: notes.key };
    expect(await client.payload(method, params)).toMatchObject(
      method === "sessions.describe"
        ? { session: { sessionId: replacement.sessionId } }
        : { sessionId: replacement.sessionId },
    );
  }
});

it("replays later commits onto an injected list without adopting its stale generation", async ({
  connect,
}) => {
  const client = sessionClient(await connect({ sessions: [notes] }), notes.key);
  const { controls } = client;
  await client.patch({ archived: true });
  const stale = { ...notes, archived: false, sessionId: "retired-generation" };
  controls.setMethodResponse("sessions.list", { sessions: [stale] });
  expect(await client.rows()).toMatchObject([{ ...stale, archived: true }]);
  expect(
    await client.patch({ expectedSessionId: stale.sessionId, label: "Wrong generation" }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  await client.patch({ label: "Renamed" });
  expect(await client.rows()).toMatchObject([{ ...stale, archived: true, label: "Renamed" }]);
  expect(await client.session()).toMatchObject({
    sessionId: notes.sessionId,
    archived: true,
    label: "Renamed",
  });
});

it("replaces canonical rows and membership without retaining omitted fields", async ({
  connect,
}) => {
  const omitted = { key: "agent:ops:omitted", sessionId: "omitted-generation" };
  const scenario = { sessions: [notes, omitted] };
  const initial = sessionClient(await connect(scenario), notes.key);
  await initial.patch({ color: "purple", label: "Patched" });
  await initial.request("sessions.create", {
    key: "agent:ops:materialized",
    label: "Materialized",
  });
  const replacement = { key: notes.key, sessionId: notes.sessionId, label: "Exact replacement" };

  initial.controls.setSessionsListResponse({ sessions: [replacement] });

  const assertReplacement = async (client: ReturnType<typeof sessionClient>) => {
    const list = await client.payload("sessions.list");
    expect(list).toMatchObject({
      count: 1,
      defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
      path: "",
      ts: expect.any(Number),
    });
    expect(list.sessions).toEqual([{ ...replacement, snapshotAt: expect.any(Number) }]);
    expect(await client.session()).toEqual({ ...replacement, snapshotAt: expect.any(Number) });
    for (const method of ["chat.history", "chat.startup"]) {
      expect(await client.transcript(method)).toMatchObject({
        sessionId: notes.sessionId,
        sessionInfo: replacement,
      });
    }
    for (const key of [omitted.key, "agent:ops:materialized"]) {
      expect((await client.payload("sessions.describe", { key })).session).toBeNull();
      expect(await client.payload("chat.startup", { sessionKey: key })).not.toHaveProperty(
        "sessionInfo",
      );
    }
  };
  await assertReplacement(initial);

  await assertReplacement(sessionClient(await connect(scenario), notes.key));
});

it.for(
  ["chat.history", "chat.startup"].flatMap((method) =>
    ["transcript", "scenario"].map((source) => ({ method, source })),
  ),
)(
  "does not replay a stopped $source Workboard run through $method",
  async ({ method, source }, { connect }) => {
    const seed = buildWorkboardMocks(1_800_000_000_000, { id: "operator", label: "Operator" });
    const key = "agent:main:workboard-onboarding";
    const transcripts: NonNullable<ControlUiMockGatewayScenario["sessionTranscripts"]> =
      seed.cardSessionHistories;
    const history = expectDefined(transcripts[key], "onboarding history");
    const runId = "workboard-onboarding-run";
    const preview = expectDefined(history.inFlightRun, "onboarding run preview");
    const connection = await connect({
      sessions: seed.cardSessions,
      sessionTranscripts:
        source === "transcript" ? transcripts : { [key]: { messages: history.messages } },
      ...(source === "scenario" ? { inFlightRun: preview } : {}),
    });
    const client = sessionClient(connection, key);
    expect((await client.transcript(method)).inFlightRun).toMatchObject({
      runId,
      text: "Checking first-task navigation and recovery after a validation error…",
    });
    expect(await client.abort({ runId })).toEqual({ aborted: true, runIds: [runId] });
    const reopened = await client.transcript(method);
    expect(reopened).toMatchObject({
      inFlightRun: null,
      sessionInfo: { key, status: "killed", hasActiveRun: false, activeRunIds: [] },
    });
    expect(reopened.messages).toEqual(history.messages);
  },
);
