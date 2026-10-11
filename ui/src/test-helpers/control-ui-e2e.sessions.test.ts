/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import { buildWorkboardMocks } from "./control-ui-workboard-fixtures.ts";

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
  expect((await request("chat.history", { sessionKey: notes.key })).payload.sessionId).toBe(
    notes.sessionId,
  );
  expect((await request("chat.startup", { sessionKey: notes.key })).payload.sessionId).toBe(
    notes.sessionId,
  );
  expect((await request("sessions.list")).payload).toMatchObject(firstList);
  expect((await request("sessions.list")).payload).toEqual(lastList);
  expect((await request("sessions.list")).payload).toEqual(lastList);
  expect((await request("chat.history", { sessionKey: notes.key, offset: 10 })).payload).toEqual(
    transcript,
  );
  controls.deferNext("chat.startup");
  const id = await send("chat.startup", { sessionKey: notes.key });
  controls.resolveDeferred("chat.startup", transcript);
  expect(response(id)?.payload).toEqual(transcript);
  controls.setMethodResponse("chat.history", transcript);
  expect((await request("chat.history", { sessionKey: notes.key })).payload).toEqual(transcript);
  expect((await request("chat.startup", { sessionKey: notes.key })).payload).toMatchObject(
    transcript,
  );
  expect((await request("sessions.describe", { key: notes.key })).payload).toMatchObject({
    session: notes,
  });
});

it("does not commit rejected patches or unresolved deferrals", async ({ connect }) => {
  const { request, send, response, controls } = await connect({ sessionKey: notes.key });
  controls.setMethodResponse("sessions.patch", {
    __mockError: { code: "INVALID_REQUEST", message: "rejected" },
  });
  expect(await request("sessions.patch", { key: notes.key, pinned: true })).toMatchObject({
    ok: false,
  });
  expect((await request("sessions.list")).payload).toMatchObject({ sessions: [{ pinned: false }] });
  controls.setMethodResponse("sessions.patch", { ok: true });
  controls.deferNext("sessions.patch");
  const pending = await send("sessions.patch", { key: notes.key, pinned: true });
  expect(response(pending)).toBeUndefined();
  expect((await request("sessions.list")).payload).toMatchObject({ sessions: [{ pinned: false }] });
  controls.rejectDeferred("sessions.patch");
  expect((await request("sessions.list")).payload).toMatchObject({ sessions: [{ pinned: false }] });
  controls.deferNext("sessions.patch");
  await send("sessions.patch", { key: notes.key, pinned: true });
  controls.resolveDeferred("sessions.patch", { ok: true });
  expect((await request("sessions.list")).payload).toMatchObject({
    sessions: [{ pinned: true, pinnedAt: expect.any(Number) }],
  });
  const beforeStalePatch = (await request("sessions.list")).payload.sessions;
  expect(
    await request("sessions.patch", {
      key: notes.key,
      expectedSessionId: "retired-generation",
      label: "Wrong generation",
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect((await request("sessions.list")).payload.sessions).toEqual(beforeStalePatch);
  const replacementSessionId = "replacement-generation";
  controls.setSessionsListResponse({
    sessions: [{ ...notes, sessionId: replacementSessionId }],
  });
  expect(
    await request("sessions.patch", {
      key: notes.key,
      expectedSessionId: replacementSessionId,
      label: "Replacement label",
    }),
  ).toMatchObject({ ok: true });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ sessionId: replacementSessionId, label: "Replacement label" }),
  ]);
  for (const method of ["sessions.describe", "chat.history", "chat.startup"]) {
    const params = method === "sessions.describe" ? { key: notes.key } : { sessionKey: notes.key };
    expect((await request(method, params)).payload).toEqual(
      expect.objectContaining(
        method === "sessions.describe"
          ? { session: expect.objectContaining({ sessionId: replacementSessionId }) }
          : { sessionId: replacementSessionId },
      ),
    );
  }
});

it("replays later commits onto an injected list without adopting its stale generation", async ({
  connect,
}) => {
  const { request, controls } = await connect({ sessions: [notes] });
  await request("sessions.patch", { key: notes.key, archived: true });
  const stale = { ...notes, archived: false, sessionId: "retired-generation" };
  controls.setMethodResponse("sessions.list", { sessions: [stale] });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ ...stale, archived: true }),
  ]);
  expect(
    await request("sessions.patch", {
      key: notes.key,
      expectedSessionId: stale.sessionId,
      label: "Wrong generation",
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  await request("sessions.patch", { key: notes.key, label: "Renamed" });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ ...stale, archived: true, label: "Renamed" }),
  ]);
  expect((await request("sessions.describe", { key: notes.key })).payload).toMatchObject({
    session: { sessionId: notes.sessionId, archived: true, label: "Renamed" },
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
    const list = (await currentRequest("sessions.list")).payload;
    expect(list).toMatchObject({
      count: 1,
      defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
      path: "",
      ts: expect.any(Number),
      sessions: [replacement],
    });
    expect(list.sessions).toEqual([{ ...replacement, snapshotAt: expect.any(Number) }]);
    expect((await currentRequest("sessions.describe", { key: notes.key })).payload.session).toEqual(
      { ...replacement, snapshotAt: expect.any(Number) },
    );
    for (const method of ["chat.history", "chat.startup"]) {
      expect((await currentRequest(method, { sessionKey: notes.key })).payload).toMatchObject({
        sessionId: notes.sessionId,
        sessionInfo: replacement,
      });
    }
    for (const key of [omitted.key, "agent:ops:materialized"]) {
      expect((await currentRequest("sessions.describe", { key })).payload.session).toBeNull();
      expect(
        (await currentRequest("chat.startup", { sessionKey: key })).payload,
      ).not.toHaveProperty("sessionInfo");
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
    expect((await request(method, { sessionKey: key })).payload.inFlightRun).toMatchObject({
      runId,
      text: "Checking first-task navigation and recovery after a validation error…",
    });
    expect((await request("chat.abort", { sessionKey: key, runId })).payload).toEqual({
      aborted: true,
      runIds: [runId],
    });
    const reopened = (await request(method, { sessionKey: key })).payload;
    expect(reopened.inFlightRun).toBeNull();
    expect(reopened.sessionInfo).toMatchObject({
      key,
      status: "killed",
      hasActiveRun: false,
      activeRunIds: [],
    });
    expect(reopened.messages).toEqual(history.messages);
  },
);
