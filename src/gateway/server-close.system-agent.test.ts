import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewaySystemAgentSession } from "./server-methods/shared-types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it("settles an accepted system-agent turn before Gateway close retires its audit database", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-system-agent-audit-close");
  const recordingEntered = createDeferred();
  const releaseRecording = createDeferred();
  const preludeEntered = createDeferred();
  let closing: Promise<void> | undefined;
  let turning: Promise<unknown> | undefined;
  try {
    fixture.config.agents = {
      ...fixture.config.agents,
      defaults: { ...fixture.config.agents?.defaults, model: "openai/gpt-5.5" },
    };
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const sessionId = "accepted-system-agent-turn";
    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    const engine: GatewaySystemAgentSession["engine"] = {
      handle: async (message) => {
        history.push(
          { role: "user", text: message },
          { role: "assistant", text: "Accepted answer" },
        );
        return { text: "Accepted answer", action: "none" };
      },
      answerWizard: async () => ({ text: "", action: "none" }),
      cancelWizard: async () => ({ text: "", action: "none" }),
      decorateRejoinReply: (reply) => reply,
      noteAssistantMessage: (text) => {
        history.push({ role: "assistant", text });
      },
      seedHistory: (turns) => {
        history.push(...turns);
      },
      historyLength: () => history.length,
      historySince: (index) => history.slice(index),
      getPendingOperatorProposal: () => null,
      resolveOperatorApproval: async () => null,
      dispose: async () => undefined,
    };
    const client = {
      ...createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
      connId: "system-agent-close-client",
    };
    kernel.gatewayRequestContext.systemAgentSessions.set(sessionId, {
      engine,
      welcome: "Synthetic welcome",
      lastUsedAt: Date.now(),
      ownerKey: `connection:${client.connId}`,
    });
    probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (command.type === "diagnostic.register") {
        recordingEntered.resolve();
        await releaseRecording.promise;
      }
      return scope.execute(command, executeOptions);
    });
    const dispatchOptions = {
      client,
      context: kernel.gatewayRequestContext,
      methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
    };
    turning = dispatchGatewayRequestInProcess(
      "openclaw.chat",
      { sessionId, message: "Accepted question" },
      dispatchOptions,
    );
    // Shutdown may revoke the reply; the accepted logbook still has to settle.
    void turning.catch(() => undefined);
    await withinTest(
      awaitGateBeforeSettlement(
        recordingEntered.promise,
        turning,
        "Turn returned before audit persistence entered its worker owner",
      ),
      signal,
    );
    kernel.scheduler.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    let closed = false;
    closing = server.close({ reason: "system-agent audit close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        preludeEntered.promise,
        closing,
        "Gateway skipped its close prelude",
      ),
      signal,
    );
    expect(closed).toBe(false);
    expect(shared.isOpen).toBe(true);
    await expect(
      dispatchGatewayRequestInProcess(
        "openclaw.chat",
        { sessionId, message: "Too late" },
        dispatchOptions,
      ),
    ).rejects.toThrow("Gateway request entry is closed");
    releaseRecording.resolve();
    await withinTest(Promise.all([turning.catch(() => undefined), closing]), signal);
    expect(shared.isOpen).toBe(false);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      const rows = database
        .prepare(
          "SELECT payload_json FROM diagnostic_events WHERE scope = 'system-agent-transcript' ORDER BY sequence",
        )
        .all();
      expect(rows.map((row) => JSON.parse(String(row.payload_json)))).toEqual([
        { role: "user", text: "Accepted question", at: expect.any(Number) },
        { role: "assistant", text: "Accepted answer", at: expect.any(Number) },
      ]);
    } finally {
      database.close();
    }
  } finally {
    releaseRecording.resolve();
    await Promise.allSettled([turning, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
