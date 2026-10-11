import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import {
  startAcpSpawnParentStreamRelay,
  type AcpSpawnParentRelayHandle,
} from "../agents/subagents/spawn/acp-spawn-parent-stream.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles accepted ACP diagnostic batches before Gateway database close and refuses late events", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-acp-diagnostics-close");
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const parentClosed = createDeferredCore();
  const draining = createDeferredCore();
  let heldWriter: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let relay: AcpSpawnParentRelayHandle | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const options = { agentId: "main", env: fixture.state.env };
    const sessionKey = "agent:main:acp:diagnostics-close";
    const sessionId = "acp-diagnostics-close-session";
    const runId = "acp-diagnostics-close-run";
    await replaceSessionEntry({ ...options, sessionKey }, { sessionId, updatedAt: 1 });
    const agent = openOpenClawAgentDatabase(options);
    const parentSessionKey = "agent:main:main";
    relay = await withPluginRuntimeGatewayContextResolver(
      kernel.resolvePluginGatewayContext,
      async () =>
        startAcpSpawnParentStreamRelay({
          ...options,
          runId,
          childSessionId: sessionId,
          childSessionKey: sessionKey,
          parentSessionKey,
          requesterAgentId: options.agentId,
          expectedTarget: await captureSessionEventTargetForHost(
            options.agentId,
            parentSessionKey,
            {
              env: fixture.state.env,
            },
          ),
          eventRouting: {},
        }),
    );
    heldWriter = runOpenClawAgentWriteAdmission(options, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await withinTest(writerEntered.promise, signal);
    const emitDiagnostic = (index: number) =>
      emitAgentEvent({
        runId,
        stream: "acp",
        data: { phase: "runtime_event", eventType: "tool_call", index },
      });
    // One full batch waits for the writer; the final event remains in the relay buffer.
    for (let index = 0; index < 101; index += 1) {
      emitDiagnostic(index);
    }
    const drainSdkWork = kernel.sdkResourceHost.drainWork.bind(kernel.sdkResourceHost);
    vi.spyOn(kernel.sdkResourceHost, "drainWork").mockImplementation(() => {
      draining.resolve();
      return drainSdkWork();
    });
    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), { once: true });
    let closed = false;
    closing = server.close({ reason: "ACP diagnostics close regression" }).then(() => {
      closed = true;
    });
    await withinTest(parentClosed.promise, signal);
    emitDiagnostic(101);
    await withinTest(
      awaitGateBeforeSettlement(
        draining.promise,
        closing,
        "Gateway closed before joining accepted ACP diagnostics",
      ),
      signal,
    );
    expect(closed).toBe(false);
    expect(agent.db.isOpen).toBe(true);
    releaseWriter.resolve();
    await withinTest(heldWriter, signal);
    await withinTest(closing, signal);
    expect(agent.db.isOpen).toBe(false);

    // A fresh connection after complete teardown observes the actual durable rows.
    const reopened = new DatabaseSync(agent.path, { readOnly: true });
    try {
      const rows = reopened
        .prepare(
          "SELECT seq, event_json FROM acp_parent_stream_events WHERE session_id = ? AND run_id = ? ORDER BY seq",
        )
        .all(sessionId, runId);
      expect(rows).toHaveLength(101);
      expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 101 }, (_, index) => index));
      for (const [index, row] of rows.entries()) {
        assert(typeof row.event_json === "string");
        const event: unknown = JSON.parse(row.event_json);
        expect(event).toMatchObject({ kind: "acp", data: { index } });
      }
    } finally {
      reopened.close();
    }
  } finally {
    releaseWriter.resolve();
    await Promise.allSettled([heldWriter, relay?.dispose(), closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
