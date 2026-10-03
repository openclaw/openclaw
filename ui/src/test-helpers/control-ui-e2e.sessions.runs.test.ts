/* @vitest-environment jsdom */
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";
import { flushMockTimers as flush } from "./mock-gateway-page.test-support.ts";

it.for(["sessions.create", "sessions.catalog.continue"])(
  "retains a terminal event before the %s acknowledgment",
  async (method, { connect }) => {
    const key = "agent:main:created-before-ack";
    const runId = "created-run";
    const { send, request, controls } = await connect({
      deferredMethods: [method],
      methodResponses: { [method]: { key, runStarted: true, runId } },
    });
    await send(method, { message: "Prepare workspace" });
    controls.emit("chat", {
      sessionKey: key,
      runId,
      state: "error",
      errorMessage: "Workspace preparation failed",
    });
    controls.resolveDeferred(method);
    await flush();
    expect((await request("sessions.describe", { key })).payload.session).toMatchObject({
      key,
      activeRunIds: [],
      hasActiveRun: false,
      status: "failed",
      lastRunError: "Workspace preparation failed",
    });
  },
);

it("commits targeted and session-wide aborts without replacing session edits or other runs", async ({
  connect,
}) => {
  const active = {
    key: "agent:main:workboard-onboarding",
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["run-a", "run-b"],
    label: "Onboarding",
  };
  const other = {
    key: "agent:main:other",
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["other-run"],
    label: "Other",
  };
  const { request, frames } = await connect({
    sessions: [active, other],
    methodResponses: { "sessions.list": { sessions: [active, other] } },
  });
  await request("sessions.patch", { key: active.key, label: "Renamed onboarding" });
  await request("sessions.patch", { key: other.key, pinned: true });
  expect(
    (await request("chat.abort", { sessionKey: active.key, runId: "unknown-run" })).payload,
  ).toMatchObject({ aborted: false, runIds: [] });
  expect(
    (await request("chat.abort", { sessionKey: active.key, runId: "run-a" })).payload,
  ).toMatchObject({ aborted: true, runIds: ["run-a"] });
  expect((await request("sessions.list")).payload.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: active.key,
        label: "Renamed onboarding",
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["run-b"],
      }),
    ]),
  );
  expect((await request("chat.abort", { sessionKey: active.key })).payload).toMatchObject({
    aborted: true,
    runIds: ["run-b"],
  });
  expect((await request("sessions.list")).payload.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: active.key,
        label: "Renamed onboarding",
        status: "killed",
        hasActiveRun: false,
        activeRunIds: [],
        abortedLastRun: true,
      }),
      expect.objectContaining({
        key: other.key,
        pinned: true,
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["other-run"],
      }),
    ]),
  );
  expect(frames.filter((frame) => frame.event === "chat").map((frame) => frame.payload)).toEqual([
    expect.objectContaining({ sessionKey: active.key, runId: "run-a", state: "aborted" }),
    expect.objectContaining({ sessionKey: active.key, runId: "run-b", state: "aborted" }),
  ]);
  expect(frames.filter((frame) => frame.event === "sessions.changed")).toHaveLength(2);
});

it.for(["direct", "descendant"] as const)(
  "settles %s activity for every later read after a session-only abort",
  async (activity, { connect }) => {
    const active = {
      key: "agent:main:main",
      updatedAt: 1_000,
      status: activity === "direct" ? "running" : "done",
      hasActiveRun: activity === "direct",
      hasActiveSubagentRun: activity === "descendant",
      ...(activity === "direct" ? { activeRunIds: ["cached-run"] } : {}),
    };
    const other = { key: "agent:main:other", status: "running", hasActiveRun: true };
    const { request } = await connect({
      sessionKey: active.key,
      sessions: [active, other],
      sessionInfo: active,
      methodResponses: {
        "sessions.abort": { ok: true, abortedRunId: null, status: "no-active-run" },
      },
    });
    await request("sessions.abort", { key: active.key, clearQueued: true });
    // The Gateway computes these rows at read time, so no read issued after Stop may
    // republish the pre-Stop activity with an older timestamp.
    const settled = {
      key: active.key,
      hasActiveRun: false,
      hasActiveSubagentRun: false,
      activeRunIds: [],
      updatedAt: expect.toSatisfy((value: number) => value > active.updatedAt),
    };
    expect((await request("sessions.describe", { key: active.key })).payload.session).toEqual(
      expect.objectContaining(settled),
    );
    for (const method of ["chat.history", "chat.startup"]) {
      expect((await request(method, { sessionKey: active.key })).payload.sessionInfo).toEqual(
        expect.objectContaining(settled),
      );
    }
    expect((await request("sessions.list")).payload.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...settled, status: "done" }),
        expect.objectContaining({ key: other.key, status: "running", hasActiveRun: true }),
      ]),
    );
  },
);

it("registers a started send for targeted abort without cancelling another run or reviving a replayed ACK", async ({
  connect,
}) => {
  const key = "agent:main:send-abort";
  const active = { key, status: "running", hasActiveRun: true, activeRunIds: ["other-run"] };
  const { request, frames } = await connect({
    sessions: [active],
    methodResponses: {
      "chat.send": { runId: "new-run", status: "started" },
      "sessions.list": { sessions: [active] },
    },
  });
  const params = { sessionKey: key, message: "Start another run", idempotencyKey: "new-run" };
  expect((await request("chat.send", params)).payload).toMatchObject({
    runId: "new-run",
    status: "started",
  });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ activeRunIds: ["other-run", "new-run"], hasActiveRun: true }),
  ]);
  expect((await request("chat.abort", { sessionKey: key, runId: "new-run" })).payload).toEqual({
    aborted: true,
    runIds: ["new-run"],
  });
  await request("chat.send", params);
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ activeRunIds: ["other-run"], hasActiveRun: true, status: "running" }),
  ]);
  expect(frames.filter((frame) => frame.event === "chat").map((frame) => frame.payload)).toEqual([
    expect.objectContaining({ sessionKey: key, runId: "new-run", state: "aborted" }),
  ]);
});

it.for([
  { event: "final", outcome: "done", otherRun: false },
  { event: "error", outcome: "failed", otherRun: false },
  { event: "aborted", outcome: "killed", otherRun: false },
  { event: "final", outcome: "done", otherRun: true },
  { event: "error", outcome: "failed", otherRun: true },
  { event: "aborted", outcome: "killed", otherRun: true },
])(
  "retains $event before a started ACK (other active run: $otherRun)",
  async ({ event, outcome, otherRun }, { connect }) => {
    const key = "agent:main:fast-completion";
    const diagnostic = "Provider request failed: session store unavailable. Retry after recovery.";
    const initial = {
      key,
      status: otherRun ? "running" : "queued",
      hasActiveRun: otherRun,
      activeRunIds: otherRun ? ["other-run"] : [],
    };
    const { send, response, request, controls } = await connect({
      sessions: [initial],
      deferredMethods: ["chat.send"],
      methodResponses: { "chat.send": { runId: "fast-run", status: "started" } },
    });
    const params = { sessionKey: key, message: "Complete quickly", idempotencyKey: "fast-run" };
    const id = await send("chat.send", params);
    expect(response(id)).toBeUndefined();
    controls.emit("chat", {
      sessionKey: key,
      runId: "fast-run",
      state: event,
      ...(event === "error" ? { errorMessage: diagnostic } : {}),
    });
    expect((await request("sessions.list")).payload.sessions).toEqual([
      expect.objectContaining(initial),
    ]);
    controls.resolveDeferred("chat.send");
    await flush();
    expect(response(id)?.payload).toMatchObject({ runId: "fast-run", status: "started" });
    expect((await request("sessions.list")).payload.sessions).toEqual([
      expect.objectContaining({
        key,
        status: otherRun ? "running" : outcome,
        hasActiveRun: otherRun,
        activeRunIds: otherRun ? ["other-run"] : [],
        abortedLastRun: !otherRun && outcome === "killed",
        ...(!otherRun && outcome === "failed" ? { lastRunError: diagnostic } : {}),
      }),
    ]);
    if (!otherRun && outcome === "failed") {
      await request("sessions.patch", { key, unread: false });
      expect(
        (await request("chat.startup", { sessionKey: key })).payload.sessionInfo,
      ).toMatchObject({
        status: "failed",
        lastRunError: diagnostic,
      });
    }
    expect((await request("chat.abort", { sessionKey: key, runId: "fast-run" })).payload).toEqual({
      aborted: false,
      runIds: [],
    });
    // A replayed ACK must not overwrite a newer outcome on the same session.
    if (otherRun) {
      controls.emit("chat", { sessionKey: key, runId: "other-run", state: "error" });
    }
    const beforeReplay = (await request("sessions.list")).payload.sessions;
    if (otherRun) {
      expect(beforeReplay).toEqual([
        expect.objectContaining({ status: "failed", hasActiveRun: false, activeRunIds: [] }),
      ]);
    }
    controls.deferNext("chat.send");
    await send("chat.send", params);
    controls.resolveDeferred("chat.send");
    await flush();
    expect((await request("sessions.list")).payload.sessions).toEqual(beforeReplay);
    if (!otherRun && outcome === "failed") {
      controls.setMethodResponse("chat.send", { runId: "next-run", status: "started" });
      controls.deferNext("chat.send");
      await send("chat.send", { ...params, idempotencyKey: "next-run" });
      controls.resolveDeferred("chat.send");
      await flush();
      const next = (await request("chat.startup", { sessionKey: key })).payload.sessionInfo;
      expect(next).toMatchObject({ status: "running", activeRunIds: ["next-run"] });
      expect(next).not.toHaveProperty("lastRunError");
      controls.emit("chat", { sessionKey: key, runId: "next-run", state: "final" });
      const completed = (await request("chat.startup", { sessionKey: key })).payload.sessionInfo;
      expect(completed).toMatchObject({ status: "done", activeRunIds: [] });
      expect(completed).not.toHaveProperty("lastRunError");
    }
  },
);

it.for([
  { event: "final", outcome: "done" },
  { event: "error", outcome: "failed" },
  { event: "aborted", outcome: "killed" },
  { event: "abort receipt", outcome: "killed" },
])(
  "preserves newer $event before the first delayed send ACK",
  async ({ event, outcome }, { connect }) => {
    const key = "agent:main:delayed-completion";
    const { send, response, request, controls } = await connect({
      sessions: [{ key, status: "running", hasActiveRun: true, activeRunIds: ["other-run"] }],
      deferredMethods: ["chat.send"],
      methodResponses: { "chat.send": { runId: "fast-run", status: "started" } },
    });
    const id = await send("chat.send", {
      sessionKey: key,
      message: "Complete before acknowledgment",
      idempotencyKey: "fast-run",
    });
    controls.emit("chat", {
      sessionKey: key,
      runId: "fast-run",
      state: "error",
      errorMessage: "Earlier run failed",
    });
    if (event === "abort receipt") {
      await request("chat.abort", { sessionKey: key, runId: "other-run" });
    } else {
      controls.emit("chat", {
        sessionKey: key,
        runId: "other-run",
        state: event,
        ...(event === "error" ? { errorMessage: "Later run failed" } : {}),
      });
    }
    const completed = (await request("chat.startup", { sessionKey: key })).payload.sessionInfo;
    expect(completed).toMatchObject({
      status: outcome,
      activeRunIds: [],
      hasActiveRun: false,
      abortedLastRun: outcome === "killed",
    });
    if (event === "error") {
      expect(completed).toHaveProperty("lastRunError", "Later run failed");
    } else {
      expect(completed).not.toHaveProperty("lastRunError");
    }
    expect(response(id)).toBeUndefined();
    controls.resolveDeferred("chat.send");
    await flush();
    expect(response(id)?.payload).toMatchObject({ runId: "fast-run", status: "started" });
    expect((await request("sessions.list")).payload.sessions).toEqual([completed]);
  },
);

it.for([
  { targeted: true, outcome: "success" },
  { targeted: false, outcome: "success" },
  { targeted: true, outcome: "not-aborted" },
  { targeted: false, outcome: "not-aborted" },
  { targeted: true, outcome: "error" },
  { targeted: false, outcome: "error" },
])(
  "preserves $outcome abort before send ACK (targeted: $targeted)",
  async ({ targeted, outcome }, { connect }) => {
    const key = "agent:main:abort-before-ack";
    const runId = "pending-run";
    const aborted = outcome === "success";
    const { send, request, controls, frames } = await connect({
      sessions: [{ key, status: "queued", hasActiveRun: false, activeRunIds: [] }],
      deferredMethods: ["chat.send"],
      methodResponses: {
        "chat.send": { runId, status: "started" },
        "chat.abort":
          outcome === "error"
            ? { __mockError: { code: "INVALID_REQUEST", message: "Abort rejected" } }
            : { aborted, runIds: aborted ? [runId] : [] },
      },
    });
    await send("chat.send", { sessionKey: key, message: "Start", idempotencyKey: runId });
    const result = await request("chat.abort", { sessionKey: key, ...(targeted ? { runId } : {}) });
    if (outcome === "error") {
      expect(result.ok).toBe(false);
    } else {
      expect(result.payload).toEqual({ aborted, runIds: aborted ? [runId] : [] });
    }
    controls.resolveDeferred("chat.send");
    await flush();
    expect((await request("sessions.list")).payload.sessions).toEqual([
      expect.objectContaining({
        key,
        status: aborted ? "killed" : "running",
        hasActiveRun: !aborted,
        activeRunIds: aborted ? [] : [runId],
      }),
    ]);
    expect(frames.filter((frame) => frame.event === "chat").map((frame) => frame.payload)).toEqual(
      aborted ? [expect.objectContaining({ sessionKey: key, runId, state: "aborted" })] : [],
    );
  },
);

it("settles only the targeted run when a session abort names a runId", async ({ connect }) => {
  const active = {
    key: "agent:main:main",
    updatedAt: 1_000,
    status: "running",
    hasActiveRun: true,
    hasActiveSubagentRun: true,
    activeRunIds: ["run-a", "run-b"],
  };
  const { request } = await connect({
    sessionKey: active.key,
    sessions: [active],
    sessionInfo: active,
    methodResponses: {
      "sessions.abort": { ok: true, abortedRunId: "run-a", status: "aborted" },
    },
  });
  const describe = async () =>
    (await request("sessions.describe", { key: active.key })).payload.session;
  await request("sessions.abort", { key: active.key, runId: "run-a" });
  // The Gateway cascades to sibling runs and descendants only without a runId.
  expect(await describe()).toEqual(
    expect.objectContaining({
      status: "running",
      hasActiveRun: true,
      hasActiveSubagentRun: true,
      activeRunIds: ["run-b"],
    }),
  );
  await request("sessions.abort", { key: active.key, clearQueued: true });
  expect(await describe()).toEqual(
    expect.objectContaining({
      status: "killed",
      hasActiveRun: false,
      hasActiveSubagentRun: false,
      activeRunIds: [],
    }),
  );
});
