import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import * as sessionReader from "./session-utils-store-worker.js";

it("joins accepted lifecycle preparation after the close prelude aborts its scheduler", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-lifecycle-read-close");
  const prepared = createDeferred();
  const release = createDeferred();
  const prelude = createDeferred();
  const caller = new AsyncWorkScope();
  let closing: Promise<void> | undefined;
  let restore: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const target = {
      agentId: "main",
      sessionKey: "agent:main:lifecycle-close",
      env: fixture.state.env,
    };
    await upsertSessionEntryCore(target, { sessionId: "lifecycle-close", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env }).db;
    const load = sessionReader.loadGatewaySessionEntryReadOnlyInWorker;
    let reads = 0;
    const reader = vi
      .spyOn(sessionReader, "loadGatewaySessionEntryReadOnlyInWorker")
      .mockImplementation(async (params) => {
        const result = await load(params);
        if (params.key === target.sessionKey && ++reads === 2) {
          // The handler's recovery read finished; its accepted persistence owns this read.
          prepared.resolve();
          await release.promise;
        }
        return result;
      });
    restore = () => reader.mockRestore();
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
    await withinTest(prepared.promise, signal);
    kernel.scheduler.signal.addEventListener(
      "abort",
      () => {
        caller.beginClose();
        prelude.resolve();
      },
      { once: true },
    );
    let closed = false;
    closing = server.close({ reason: "lifecycle read close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        prelude.promise,
        closing,
        "Gateway closed before its close prelude",
      ),
      signal,
    );
    expect(caller.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(database.isOpen).toBe(true);
    release.resolve();
    await withinTest(closing, signal);
    expect(database.isOpen).toBe(false);
    expect(loadSessionEntryReadOnly(target)).toMatchObject({
      status: "running",
      lifecycleRunId: "lifecycle-close-run",
      startedAt: 1_000,
    });
  } finally {
    release.resolve();
    await closing?.catch(() => undefined);
    restore?.();
    await caller.drain();
    await fixture.cleanup();
  }
});
