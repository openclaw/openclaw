/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import { buildWorkboardMocks } from "./control-ui-workboard-fixtures.ts";
import { sessionClient } from "./session-gateway-client.test-support.ts";

const notes = { key: "agent:ops:notes", sessionId: "notes-generation-1", label: "Notes" };

it("preserves stale wire responses without consuming sequences or replacing canonical identity", async ({
  connect,
}) => {
  const stale = { ...notes, sessionId: "retired-generation", pinned: false };
  const firstList = { sessions: [stale], offset: 10 };
  const lastList = { sessions: [], offset: 20 };
  const transcript = { messages: [], sessionId: "retired-transcript", sessionInfo: stale };
  const { request, controls, send, response } = await connect({
    sessions: [notes],
    methodResponses: {
      "sessions.list": { sequence: [firstList, lastList] },
      "chat.history": {
        cases: [{ match: { sessionKey: notes.key, offset: 10 }, response: transcript }],
      },
    },
  });
  const client = sessionClient(request, notes.key);
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
  const { request, send, response, controls } = await connect({ sessionKey: notes.key });
  const client = sessionClient(request, notes.key);
  controls.setMethodResponse("sessions.patch", {
    __mockError: { code: "INVALID_REQUEST", message: "rejected" },
  });
  expect(await client.patch({ pinned: true })).toMatchObject({ ok: false });
  expect(await client.payload("sessions.list")).toMatchObject({ sessions: [{ pinned: false }] });
  controls.setMethodResponse("sessions.patch", { ok: true });
  controls.deferNext("sessions.patch");
  const pending = await send("sessions.patch", { key: notes.key, pinned: true });
  expect(response(pending)).toBeUndefined();
  expect(await client.payload("sessions.list")).toMatchObject({ sessions: [{ pinned: false }] });
  controls.rejectDeferred("sessions.patch");
  expect(await client.payload("sessions.list")).toMatchObject({ sessions: [{ pinned: false }] });
  controls.deferNext("sessions.patch");
  await send("sessions.patch", { key: notes.key, pinned: true });
  controls.resolveDeferred("sessions.patch", { ok: true });
  expect(await client.payload("sessions.list")).toMatchObject({
    sessions: [{ pinned: true, pinnedAt: expect.any(Number) }],
  });
  const beforeStalePatch = await client.rows();
  expect(
    await client.patch({ expectedSessionId: "retired-generation", label: "Wrong generation" }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(await client.rows()).toEqual(beforeStalePatch);
  const replacementSessionId = "replacement-generation";
  controls.setSessionsListResponse({
    sessions: [{ ...notes, sessionId: replacementSessionId }],
  });
  expect(
    await client.patch({ expectedSessionId: replacementSessionId, label: "Replacement label" }),
  ).toMatchObject({ ok: true });
  expect(await client.rows()).toMatchObject([
    { sessionId: replacementSessionId, label: "Replacement label" },
  ]);
  for (const method of ["sessions.describe", "chat.history", "chat.startup"]) {
    const params = method === "sessions.describe" ? { key: notes.key } : { sessionKey: notes.key };
    expect(await client.payload(method, params)).toMatchObject(
      method === "sessions.describe"
        ? { session: { sessionId: replacementSessionId } }
        : { sessionId: replacementSessionId },
    );
  }
});

it("replays later commits onto an injected list without adopting its stale generation", async ({
  connect,
}) => {
  const { request, controls } = await connect({ sessions: [notes] });
  const client = sessionClient(request, notes.key);
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
  const { request, controls } = await connect(scenario);
  await request("sessions.patch", { key: notes.key, color: "purple", label: "Patched" });
  await request("sessions.create", { key: "agent:ops:materialized", label: "Materialized" });
  const replacement = { key: notes.key, sessionId: notes.sessionId, label: "Exact replacement" };

  controls.setSessionsListResponse({ sessions: [replacement] });

  const assertReplacement = async (currentRequest: typeof request) => {
    const client = sessionClient(currentRequest, notes.key);
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
      expect((await currentRequest("sessions.describe", { key })).payload.session).toBeNull();
      expect(await client.payload("chat.startup", { sessionKey: key })).not.toHaveProperty(
        "sessionInfo",
      );
    }
  };
  await assertReplacement(request);

  const reloaded = await connect(scenario);
  await assertReplacement(reloaded.request);
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
    const { request } = await connect({
      sessions: seed.cardSessions,
      sessionTranscripts:
        source === "transcript" ? transcripts : { [key]: { messages: history.messages } },
      ...(source === "scenario" ? { inFlightRun: preview } : {}),
    });
    const client = sessionClient(request, key);
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
