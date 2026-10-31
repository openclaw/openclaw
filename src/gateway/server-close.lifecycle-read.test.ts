import { expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";
import * as sessionReader from "./session-utils-store-worker.js";

it("joins accepted lifecycle preparation after the close prelude aborts its scheduler", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-lifecycle-read-close", signal);
  const caller = new AsyncWorkScope();
  try {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:lifecycle-close",
      env: race.fixture.state.env,
    };
    await upsertSessionEntryCore(target, { sessionId: "lifecycle-close", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: target.env }).db;
    const load = sessionReader.loadGatewaySessionEntryReadOnlyInWorker;
    let reads = 0;
    const reader = vi
      .spyOn(sessionReader, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementation(async (params) => {
        const result = await load(params);
        // Hold the lifecycle owner's accepted persistence read.
        if (params.key === target.sessionKey && ++reads === 1) {
          await race.block();
        }
        return result;
      });
    race.onCleanup(() => reader.mockRestore());
    race.onCleanup(() => caller.drain());
    caller.run(() =>
      emitAgentEvent({
        runId: "lifecycle-close-run",
        agentId: "main",
        sessionKey: target.sessionKey,
        sessionId: "lifecycle-close",
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      }),
    );
    await race.waitForEntry();
    await race.close(race.kernel.scheduler.signal, () => caller.beginClose(), {
      reason: "lifecycle read close regression",
    });
    expect(caller.signal.aborted).toBe(true);
    expect(race.closed).toBe(false);
    expect(database.isOpen).toBe(true);
    await race.finish();
    expect(database.isOpen).toBe(false);
    expect(loadSessionEntryReadOnly(target)).toMatchObject({
      lifecycleRunId: "lifecycle-close-run",
      startedAt: 1_000,
    });
    expect(loadSessionEntryReadOnly(target)?.status).toBeUndefined();
  } finally {
    await race.dispose();
  }
});
