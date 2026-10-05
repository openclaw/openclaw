import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as agentWorker from "../state/openclaw-agent-worker-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it("joins an accepted Board read across the close prelude before closing its worker", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-board-read-close");
  const readEntered = createDeferred();
  const releaseRead = createDeferred();
  const preludeEntered = createDeferred();
  let closing: Promise<void> | undefined;
  let reading: Promise<unknown> | undefined;
  let restoreRead: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const dispatchOptions = {
      client: createSyntheticPluginRuntimeClient({
        sessionCreation: { via: "spawn", actor: { type: "agent", id: "main" } },
      }),
      context: kernel.gatewayRequestContext,
      methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
    };
    const sessionKey = "agent:main:dashboard:accepted-board-close";
    await dispatchGatewayRequestInProcess("sessions.create", { key: sessionKey }, dispatchOptions);
    await dispatchGatewayRequestInProcess(
      "board.widget.put",
      { sessionKey, name: "status", content: { kind: "html", html: "accepted" } },
      dispatchOptions,
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env }).db;
    const open = agentWorker.openOpenClawAgentSqliteWorkerStore;
    let readSettled = false;
    const interception = vi
      .spyOn(agentWorker, "openOpenClawAgentSqliteWorkerStore")
      .mockImplementation(async (...args) => {
        const publication = await open(...args);
        return {
          ...publication,
          run: (operation, assertCurrent) =>
            publication.run(
              (scope) =>
                operation({
                  execute: async (command, options) => {
                    if (command.type !== "boards.readSnapshot") {
                      return scope.execute(command, options);
                    }
                    readEntered.resolve();
                    await releaseRead.promise;
                    const value = await scope.execute(command, options);
                    readSettled = true;
                    return value;
                  },
                }),
              assertCurrent,
            ),
        };
      });
    restoreRead = () => interception.mockRestore();
    reading = dispatchGatewayRequestInProcess("board.get", { sessionKey }, dispatchOptions).catch(
      (error: unknown) => error,
    );
    await withinTest(
      awaitGateBeforeSettlement(readEntered.promise, reading, "Board read bypassed its worker"),
      signal,
    );
    kernel.requestEntryLifetime.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    let closed = false;
    closing = server.close({ reason: "gateway restarting", restartExpectedMs: 1_500 }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        preludeEntered.promise,
        closing,
        "Gateway closed before fencing request admission",
      ),
      signal,
    );
    await expect(
      dispatchGatewayRequestInProcess("board.get", { sessionKey }, dispatchOptions),
    ).rejects.toThrow("Gateway request entry is closed");
    expect(closed).toBe(false);
    expect(readSettled).toBe(false);
    expect(database.isOpen).toBe(true);

    releaseRead.resolve();
    const [result] = await withinTest(Promise.all([reading, closing]), signal);
    expect(readSettled).toBe(true);
    expect(result).toBeInstanceOf(Error);
    expect(database.isOpen).toBe(false);
  } finally {
    releaseRead.resolve();
    await Promise.allSettled([reading, closing]);
    restoreRead?.();
    await fixture.cleanup();
  }
});
