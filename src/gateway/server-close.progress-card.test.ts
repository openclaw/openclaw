import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { ProgressCardPutResult } from "../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as agentWriteAdmission from "../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { progressCardStore } from "./progress-card-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it("settles a queued progress card across the close prelude before retiring its database", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-progress-card-close");
  const writerEntered = createDeferred();
  const releaseWriter = createDeferred();
  const cardQueued = createDeferred();
  const drainEntered = createDeferred();
  let holding: Promise<void> | undefined;
  let putting: Promise<ProgressCardPutResult> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
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
      holding = writeAdmission(databaseOptions, async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
      });
      await writerEntered.promise;
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
    putting = dispatchGatewayRequestInProcess<ProgressCardPutResult>(
      "progressCard.put",
      { sessionKey, markdown: "Accepted before shutdown" },
      dispatchOptions,
    );
    await withinTest(
      awaitGateBeforeSettlement(
        cardQueued.promise,
        putting,
        "Progress card settled before joining the database writer queue",
      ),
      signal,
    );
    const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
    vi.spyOn(kernel.connectionWork, "drain").mockImplementation(() => {
      drainEntered.resolve();
      return drain();
    });
    let closed = false;
    closing = server.close({ reason: "progress card close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        drainEntered.promise,
        closing,
        "Gateway closed before joining its accepted progress card",
      ),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(kernel.connectionWork.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(shared.isOpen).toBe(true);
    await expect(
      dispatchGatewayRequestInProcess(
        "progressCard.put",
        { sessionKey, markdown: "Refused after shutdown" },
        dispatchOptions,
      ),
    ).rejects.toThrow("Gateway request entry is closed");

    releaseWriter.resolve();
    const [result] = await withinTest(Promise.all([putting, holding, closing]), signal);
    expect(result.card).toMatchObject({ markdown: "Accepted before shutdown", revision: 1 });
    expect(shared.isOpen).toBe(false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT session_key, markdown, revision FROM session_progress_cards")
          .all(),
      ).toEqual([{ session_key: sessionKey, markdown: "Accepted before shutdown", revision: 1 }]);
    } finally {
      database.close();
    }
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([putting, holding, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
