/* @vitest-environment jsdom */
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";
import { flushMockTimers as flush } from "./mock-gateway-page.test-support.ts";

it.for(["sessions.create", "sessions.catalog.continue"])(
  "materializes %s identity and settles its started run for every read",
  async (method, { connect }) => {
    const key = "agent:main:created";
    const runId = "created-run";
    const { request, controls, send, response } = await connect({
      methodResponses: {
        [method]: { key, entry: { sessionId: "created-generation" }, runStarted: true, runId },
      },
    });
    await request(method, { label: "Created" });
    for (const read of ["chat.history", "chat.startup"]) {
      expect((await request(read, { sessionKey: key })).payload).toMatchObject({
        sessionId: "created-generation",
        sessionInfo: { key, sessionId: "created-generation", label: "Created", hasActiveRun: true },
      });
    }
    expect((await request("sessions.describe", { key })).payload).toMatchObject({
      session: { key, sessionId: "created-generation" },
    });
    expect((await request("sessions.list")).payload.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ key, sessionId: "created-generation" })]),
    );
    controls.emit("chat", { sessionKey: key, runId, state: "error", errorMessage: "Setup failed" });
    const settled = {
      key,
      sessionId: "created-generation",
      hasActiveRun: false,
      activeRunIds: [],
      status: "failed",
      lastRunError: "Setup failed",
    };
    for (const read of ["chat.history", "chat.startup"]) {
      expect((await request(read, { sessionKey: key })).payload.sessionInfo).toMatchObject(settled);
    }
    expect((await request("sessions.describe", { key })).payload.session).toMatchObject(settled);
    expect((await request("sessions.list")).payload.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining(settled)]),
    );
    await request(method, { label: "Created" });
    expect((await request("sessions.describe", { key })).payload.session).toMatchObject(settled);
    controls.setMethodResponse(method, {
      key,
      sessionId: "replacement-generation",
      runStarted: true,
      runId: "replacement-run-initial",
    });
    await request(method, { label: "Replacement" });
    expect((await request("sessions.describe", { key })).payload.session).toMatchObject({
      key,
      sessionId: "replacement-generation",
      hasActiveRun: true,
      activeRunIds: ["replacement-run-initial"],
      status: "running",
    });
    for (const entryRunIds of [[], ["entry-run"]]) {
      const sessionId = `active-replacement-${entryRunIds.length}`;
      controls.setMethodResponse(method, {
        key,
        sessionId,
        runStarted: true,
        runId: "replacement-run",
        ...(entryRunIds.length ? { entry: { activeRunIds: entryRunIds } } : {}),
      });
      await request(method, { label: "Replacement" });
      expect((await request("sessions.describe", { key })).payload.session).toMatchObject({
        key,
        sessionId,
        hasActiveRun: true,
        activeRunIds: [...entryRunIds, "replacement-run"],
        status: "running",
      });
    }
    for (const { pendingKey, terminal } of [
      { pendingKey: "agent:main:created-early", terminal: "error" },
      { pendingKey: key, terminal: "error" },
      { pendingKey: "agent:main:created-aborted", terminal: "abort" },
      { pendingKey: key, terminal: "abort" },
    ]) {
      const pendingRunId = `${pendingKey}:${terminal}:run`;
      controls.setMethodResponse(method, {
        key: pendingKey,
        sessionId: `${pendingKey}:${terminal}:generation`,
        runStarted: true,
        runId: pendingRunId,
      });
      controls.deferNext(method);
      const requestId = await send(method, { label: "Early" });
      expect(response(requestId)).toBeUndefined();
      if (terminal === "abort") {
        controls.setMethodResponse("chat.abort", { aborted: true, runIds: [pendingRunId] });
        await request("chat.abort", { sessionKey: pendingKey, runId: pendingRunId });
      } else {
        controls.emit("chat", {
          sessionKey: pendingKey,
          runId: pendingRunId,
          state: "error",
          errorMessage: "Early setup failure",
        });
      }
      controls.resolveDeferred(method);
      await flush();
      expect(
        (await request("sessions.describe", { key: pendingKey })).payload.session,
      ).toMatchObject({
        key: pendingKey,
        sessionId: `${pendingKey}:${terminal}:generation`,
        hasActiveRun: false,
        activeRunIds: [],
        status: terminal === "abort" ? "killed" : "failed",
        ...(terminal === "abort"
          ? { abortedLastRun: true }
          : { lastRunError: "Early setup failure" }),
      });
    }
  },
);
