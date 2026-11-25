import { expect, it, vi } from "vitest";
import type { ProgressCardPutResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as agentWriteAdmission from "../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { progressCardStore } from "./progress-card-store.js";
import { createTestGate, readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it("settles a queued progress card across the close prelude before retiring its database", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-progress-card-close", signal);
  const { fixture, kernel } = race;
  const gate = createTestGate(signal);
  const cardQueued = createDeferred();
  const drainEntered = new AbortController();
  let holding: Promise<void> | undefined;
  let putting: Promise<ProgressCardPutResult> | undefined;
  try {
    const sessionKey = "agent:main:dashboard:accepted-close-progress";
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId: "progress-card-close-session", updatedAt: 1 },
    );
    const databaseOptions = { agentId: "main", env: fixture.state.env };
    const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const writeAdmission = agentWriteAdmission.runOpenClawAgentWriteAdmission;
    const put = progressCardStore.put.bind(progressCardStore);
    vi.spyOn(progressCardStore, "put").mockImplementationOnce(async (...args) => {
      holding = writeAdmission(databaseOptions, () => race.block());
      await race.waitForEntry();
      return put(...args);
    });
    vi.spyOn(agentWriteAdmission, "runOpenClawAgentWriteAdmission").mockImplementation(
      (options, run, reentrant, timing, cancellation) => {
        const pending = writeAdmission(options, run, reentrant, timing, cancellation);
        if (holding && resolveOpenClawAgentSqlitePath(options) === databasePath) {
          cardQueued.resolve();
        }
        return pending;
      },
    );
    const dispatchOptions = {
      client: createSyntheticPluginRuntimeClient(),
      context: kernel.gatewayRequestContext,
      methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
    };
    const putCard = (markdown: string) =>
      dispatchGatewayRequestInProcess<ProgressCardPutResult>(
        "progressCard.put",
        { sessionKey, markdown },
        dispatchOptions,
      );
    putting = putCard("Accepted before shutdown");
    await gate(
      cardQueued.promise,
      putting,
      "Progress card settled before joining the database writer queue",
    );
    const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
    vi.spyOn(kernel.connectionWork, "drain").mockImplementation(() => {
      drainEntered.abort();
      return drain();
    });
    await race.close(drainEntered.signal, undefined, { reason: "progress card close regression" });
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(kernel.connectionWork.signal.aborted).toBe(true);
    expect(race.closed).toBe(false);
    expect(shared.isOpen).toBe(true);
    await expect(putCard("Refused after shutdown")).rejects.toThrow(
      "Gateway request entry is closed",
    );

    const [result] = (await race.finish(Promise.all([putting, holding])))!;
    expect(result.card).toMatchObject({ markdown: "Accepted before shutdown", revision: 1 });
    expect(shared.isOpen).toBe(false);
    const rows = readClosedDatabase(
      databasePath,
      "SELECT session_key, markdown, revision FROM session_progress_cards",
    );
    expect(rows).toEqual([
      { session_key: sessionKey, markdown: "Accepted before shutdown", revision: 1 },
    ]);
  } finally {
    race.onCleanup(async () => {
      await Promise.allSettled([putting, holding]);
      vi.restoreAllMocks();
    });
    await race.dispose();
  }
});
