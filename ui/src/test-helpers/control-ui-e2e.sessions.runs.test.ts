/* @vitest-environment jsdom */
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";
import { sessionClient } from "./session-gateway-client.test-support.ts";

const runFacts = (status: string, activeRunIds: string[] = []) => ({
  status,
  activeRunIds,
  hasActiveRun: activeRunIds.length > 0,
});
const abortedRuns = (runIds: string[]) => ({ aborted: runIds.length > 0, runIds });

it.for(["sessions.create", "sessions.catalog.continue"])(
  "retains a terminal event before the %s acknowledgment",
  async (method, { connect }) => {
    const key = "agent:main:created-before-ack";
    const runId = "created-run";
    const connection = await connect({
      deferredMethods: [method],
      methodResponses: { [method]: { key, runStarted: true, runId } },
    });
    const client = sessionClient(connection, key);
    await client.send(method, { message: "Prepare workspace" });
    client.emitChat(runId, "error", "Workspace preparation failed");
    await client.resolve(method);
    expect(await client.session()).toMatchObject({
      key,
      ...runFacts("failed"),
      lastRunError: "Workspace preparation failed",
    });
  },
);

it("commits targeted and session-wide aborts without replacing session edits or other runs", async ({
  connect,
}) => {
  const active = {
    key: "agent:main:workboard-onboarding",
    ...runFacts("running", ["run-a", "run-b"]),
    label: "Onboarding",
  };
  const other = {
    key: "agent:main:other",
    ...runFacts("running", ["other-run"]),
    label: "Other",
  };
  const connection = await connect({
    sessions: [active, other],
    methodResponses: { "sessions.list": { sessions: [active, other] } },
  });
  const client = sessionClient(connection, active.key);
  await client.patch({ label: "Renamed onboarding" });
  await client.request("sessions.patch", { key: other.key, pinned: true });
  expect(await client.abort({ runId: "unknown-run" })).toMatchObject(abortedRuns([]));
  expect(await client.abort({ runId: "run-a" })).toMatchObject(abortedRuns(["run-a"]));
  const expectRows = async (...rows: Record<string, unknown>[]) => {
    expect(await client.rows()).toEqual(
      expect.arrayContaining(rows.map((row) => expect.objectContaining(row))),
    );
  };
  await expectRows({ ...active, label: "Renamed onboarding", activeRunIds: ["run-b"] });
  expect(await client.abort()).toMatchObject(abortedRuns(["run-b"]));
  await expectRows(
    {
      ...active,
      label: "Renamed onboarding",
      ...runFacts("killed"),
      abortedLastRun: true,
    },
    { ...other, pinned: true },
  );
  expect(client.chatEvents()).toEqual([
    expect.objectContaining({ sessionKey: active.key, runId: "run-a", state: "aborted" }),
    expect.objectContaining({ sessionKey: active.key, runId: "run-b", state: "aborted" }),
  ]);
  expect(client.frames.filter((frame) => frame.event === "sessions.changed")).toHaveLength(2);
});

it.for(["direct", "descendant", "targeted"] as const)(
  "settles %s activity for every later read after a session-only abort",
  async (activity, { connect }) => {
    const active = {
      key: "agent:main:main",
      updatedAt: 1_000,
      status: activity === "descendant" ? "done" : "running",
      hasActiveRun: activity !== "descendant",
      hasActiveSubagentRun: activity !== "direct",
      ...(activity === "targeted"
        ? { activeRunIds: ["run-a", "run-b"] }
        : activity === "direct"
          ? { activeRunIds: ["cached-run"] }
          : {}),
    };
    const other = { key: "agent:main:other", status: "running", hasActiveRun: true };
    const connection = await connect({
      sessionKey: active.key,
      sessions: [active, other],
      sessionInfo: active,
      methodResponses: {
        "sessions.abort":
          activity === "targeted"
            ? { ok: true, abortedRunId: "run-a", status: "aborted" }
            : { ok: true, abortedRunId: null, status: "no-active-run" },
      },
    });
    const client = sessionClient(connection, active.key);
    if (activity === "targeted") {
      await client.request("sessions.abort", { key: active.key, runId: "run-a" });
      expect(await client.session()).toMatchObject({
        ...runFacts("running", ["run-b"]),
        hasActiveSubagentRun: true,
      });
    }
    await client.request("sessions.abort", { key: active.key, clearQueued: true });
    // Read-time rows must not republish pre-Stop activity or timestamps.
    const settled = {
      key: active.key,
      ...runFacts(activity === "targeted" ? "killed" : "done"),
      hasActiveSubagentRun: false,
      updatedAt: expect.toSatisfy((value: number) => value > active.updatedAt),
    };
    expect(await client.session()).toMatchObject(settled);
    for (const method of ["chat.history", "chat.startup"]) {
      expect((await client.transcript(method)).sessionInfo).toMatchObject(settled);
    }
    expect(await client.rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining(settled),
        expect.objectContaining({ key: other.key, status: "running", hasActiveRun: true }),
      ]),
    );
  },
);

it("registers a started send for targeted abort without cancelling another run or reviving a replayed ACK", async ({
  connect,
}) => {
  const key = "agent:main:send-abort";
  const active = { key, ...runFacts("running", ["other-run"]) };
  const connection = await connect({
    sessions: [active],
    methodResponses: {
      "chat.send": { runId: "new-run", status: "started" },
      "sessions.list": { sessions: [active] },
    },
  });
  const client = sessionClient(connection, key);
  const params = { sessionKey: key, message: "Start another run", idempotencyKey: "new-run" };
  expect(await client.payload("chat.send", params)).toMatchObject({
    runId: "new-run",
    status: "started",
  });
  expect(await client.rows()).toMatchObject([
    { activeRunIds: ["other-run", "new-run"], hasActiveRun: true },
  ]);
  expect(await client.abort({ runId: "new-run" })).toEqual(abortedRuns(["new-run"]));
  await client.request("chat.send", params);
  expect(await client.rows()).toMatchObject([
    { activeRunIds: ["other-run"], hasActiveRun: true, status: "running" },
  ]);
  expect(client.chatEvents()).toEqual([
    expect.objectContaining({ sessionKey: key, runId: "new-run", state: "aborted" }),
  ]);
});

it.for([
  { event: "final", outcome: "done", otherRun: false, newerEvent: null },
  { event: "error", outcome: "failed", otherRun: false, newerEvent: null },
  { event: "aborted", outcome: "killed", otherRun: false, newerEvent: null },
  { event: "final", outcome: "done", otherRun: true, newerEvent: null },
  { event: "error", outcome: "failed", otherRun: true, newerEvent: null },
  { event: "aborted", outcome: "killed", otherRun: true, newerEvent: null },
  { event: "error", outcome: "done", otherRun: true, newerEvent: "final" },
  { event: "error", outcome: "failed", otherRun: true, newerEvent: "error" },
  { event: "error", outcome: "killed", otherRun: true, newerEvent: "aborted" },
  { event: "error", outcome: "killed", otherRun: true, newerEvent: "abort receipt" },
])(
  "retains $event before a started ACK (other run: $otherRun, newer event: $newerEvent)",
  async ({ event, outcome, otherRun, newerEvent }, { connect }) => {
    const key = "agent:main:fast-completion";
    const diagnostic = "Provider request failed: session store unavailable. Retry after recovery.";
    const initial = {
      key,
      ...runFacts(otherRun ? "running" : "queued", otherRun ? ["other-run"] : []),
    };
    const connection = await connect({
      sessions: [initial],
      deferredMethods: ["chat.send"],
      methodResponses: { "chat.send": { runId: "fast-run", status: "started" } },
    });
    const client = sessionClient(connection, key);
    const { controls, response } = client;
    const id = await client.sendChat("fast-run", "Complete quickly");
    expect(response(id)).toBeUndefined();
    client.emitChat("fast-run", event, event === "error" ? diagnostic : undefined);
    expect(await client.rows()).toMatchObject([initial]);
    let newerCompletion: unknown;
    if (newerEvent) {
      if (newerEvent === "abort receipt") {
        await client.abort({ runId: "other-run" });
      } else {
        client.emitChat(
          "other-run",
          newerEvent,
          newerEvent === "error" ? "Later run failed" : undefined,
        );
      }
      newerCompletion = (await client.transcript()).sessionInfo;
      expect(newerCompletion).toMatchObject({
        ...runFacts(outcome),
        abortedLastRun: outcome === "killed",
      });
      if (newerEvent === "error") {
        expect(newerCompletion).toHaveProperty("lastRunError", "Later run failed");
      } else {
        expect(newerCompletion).not.toHaveProperty("lastRunError");
      }
      expect(response(id)).toBeUndefined();
    }
    await client.resolve("chat.send");
    expect(response(id)?.payload).toMatchObject({ runId: "fast-run", status: "started" });
    if (newerEvent) {
      expect(await client.rows()).toEqual([newerCompletion]);
      return;
    }
    expect(await client.rows()).toMatchObject([
      {
        key,
        ...runFacts(otherRun ? "running" : outcome, otherRun ? ["other-run"] : []),
        abortedLastRun: !otherRun && outcome === "killed",
        ...(!otherRun && outcome === "failed" ? { lastRunError: diagnostic } : {}),
      },
    ]);
    if (!otherRun && outcome === "failed") {
      await client.patch({ unread: false });
      expect((await client.transcript()).sessionInfo).toMatchObject({
        status: "failed",
        lastRunError: diagnostic,
      });
    }
    expect(await client.abort({ runId: "fast-run" })).toEqual(abortedRuns([]));
    // A replayed ACK must not overwrite a newer outcome on the same session.
    if (otherRun) {
      client.emitChat("other-run", "error");
    }
    const beforeReplay = await client.rows();
    if (otherRun) {
      expect(beforeReplay).toMatchObject([runFacts("failed")]);
    }
    controls.deferNext("chat.send");
    await client.sendChat("fast-run", "Complete quickly");
    await client.resolve("chat.send");
    expect(await client.rows()).toEqual(beforeReplay);
    if (!otherRun && outcome === "failed") {
      controls.setMethodResponse("chat.send", { runId: "next-run", status: "started" });
      controls.deferNext("chat.send");
      await client.sendChat("next-run", "Complete quickly");
      await client.resolve("chat.send");
      const next = (await client.transcript()).sessionInfo;
      expect(next).toMatchObject({ status: "running", activeRunIds: ["next-run"] });
      expect(next).not.toHaveProperty("lastRunError");
      client.emitChat("next-run", "final");
      const completed = (await client.transcript()).sessionInfo;
      expect(completed).toMatchObject({ status: "done", activeRunIds: [] });
      expect(completed).not.toHaveProperty("lastRunError");
    }
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
    const connection = await connect({
      sessions: [{ key, ...runFacts("queued") }],
      deferredMethods: ["chat.send"],
      methodResponses: {
        "chat.send": { runId, status: "started" },
        "chat.abort":
          outcome === "error"
            ? { __mockError: { code: "INVALID_REQUEST", message: "Abort rejected" } }
            : abortedRuns(aborted ? [runId] : []),
      },
    });
    const client = sessionClient(connection, key);
    await client.sendChat(runId);
    const result = await client.request("chat.abort", {
      sessionKey: key,
      ...(targeted ? { runId } : {}),
    });
    if (outcome === "error") {
      expect(result.ok).toBe(false);
    } else {
      expect(result.payload).toEqual(abortedRuns(aborted ? [runId] : []));
    }
    await client.resolve("chat.send");
    expect(await client.rows()).toMatchObject([
      {
        key,
        ...runFacts(aborted ? "killed" : "running", aborted ? [] : [runId]),
      },
    ]);
    expect(client.chatEvents()).toEqual(
      aborted ? [expect.objectContaining({ sessionKey: key, runId, state: "aborted" })] : [],
    );
  },
);
