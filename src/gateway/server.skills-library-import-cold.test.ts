import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks } from "./test-helpers.js";

// The public successful-import adapter proves publication. These cases fault only
// loading and observe the real WebSocket request and Gateway settlement owners.
for (const mode of ["disconnect", "shutdown", "revocation"] as const) {
  describe(`cold library import during ${mode}`, () => {
    let harness: GatewayServerHarness;
    let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
    let acquisition: Promise<GatewayServerHarness> | undefined;
    installGatewayTestHooks({
      scope: "suite",
      setup: async () => {
        kernel = await captureGatewayKernel(async () => {
          acquisition = startGatewayServerHarness();
          harness = await acquisition;
          const [{ coreGatewayHandlers }, { prepareGatewayRequestHandler }] = await Promise.all([
            import("./server-methods/core-handlers.js"),
            import("./server-methods/lazy-core-handlers.js"),
          ]);
          await prepareGatewayRequestHandler(coreGatewayHandlers["skills.library.import"]!);
        });
      },
      cleanup: async () => {
        const [result] = await Promise.allSettled([acquisition]);
        if (result.status === "fulfilled") {
          await result.value?.close();
        }
      },
    });

    it(
      mode === "revocation"
        ? "rejects revoked device authority after loading before backend entry"
        : "retains accepted request authority and settles before dependencies stop",
      async ({ signal }) => {
        const importStarted = createDeferred();
        const releaseImport = createDeferred();
        const importCompleted = createDeferred();
        const drainEntered = createDeferred();
        const order: string[] = [];
        const runtime = kernel.gatewayInstanceRuntime;
        const backendEntered = vi.fn();
        let requestExecution: Promise<unknown> | undefined;
        const requestFinished = createDeferred();
        let closing: Promise<void> | undefined;
        let captureCount = 0;
        let settled = false;
        const release = () => releaseImport.resolve();
        signal.addEventListener("abort", release, { once: true });
        try {
          vi.doMock("../skills/library/import.js", async (importOriginal) => {
            importStarted.resolve();
            await releaseImport.promise;
            const actual = await importOriginal<typeof import("../skills/library/import.js")>();
            importCompleted.resolve();
            return {
              ...actual,
              importSkillLibrary: (...args: Parameters<typeof actual.importSkillLibrary>) => {
                backendEntered();
                return actual.importSkillLibrary(...args);
              },
            };
          });
          const { ws } = await harness.openClient();
          await nextTurn(); // Retire handshake work before observing the one request below.
          const track = kernel.connectionWork.track.bind(kernel.connectionWork);
          using tracking = vi.spyOn(kernel.connectionWork, "track").mockImplementation(function <T>(
            run: () => T | Promise<T>,
          ): Promise<T> {
            const execution = track(run);
            captureCount++;
            requestExecution = execution;
            void execution.then(
              () => {
                settled = true;
                order.push("request settled");
                requestFinished.resolve();
              },
              () => {
                settled = true;
                order.push("request settled");
                requestFinished.resolve();
              },
            );
            return execution;
          });
          const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
          vi.spyOn(kernel.connectionWork, "drain").mockImplementation(() => {
            const operation = drain();
            drainEntered.resolve();
            return operation;
          });
          kernel.registerGatewayLifetimeSidecars({
            stop: async () => {
              order.push("dependencies stopped");
            },
          });
          ws.send(
            JSON.stringify({
              type: "req",
              id: "held-library-import",
              method: "skills.library.import",
              params: {
                slug: `cold-${mode}`,
                source: { kind: "clawhub", slug: "cold-source", version: "1.0.0" },
              },
            }),
          );
          await withinTest(
            awaitGateBeforeSettlement(
              importStarted.promise,
              requestFinished.promise,
              "Native cold import was not reached",
            ),
            signal,
          );
          expect(captureCount).toBe(1);
          expect(requestExecution).toBeDefined();
          tracking.mockRestore();
          expect(settled).toBe(false);
          expect(backendEntered).not.toHaveBeenCalled();

          if (mode === "disconnect") {
            const disconnected = new Promise<void>((resolve) => {
              ws.once("close", () => resolve());
            });
            ws.close();
            await withinTest(disconnected, signal);
            expect(settled).toBe(false);
            expect(runtime.isAvailable()).toBe(true);
          } else if (mode === "revocation") {
            const [client] = [...kernel.clients];
            expect(kernel.clients.size).toBe(1);
            const invalidate = kernel.gatewayRequestContext.invalidateClientsForDevice;
            if (!client?.connect.device?.id || !invalidate) {
              throw new Error(
                "Cold import requires the native device authority owner and identity",
              );
            }
            const deviceId = client.connect.device.id;
            expect(client.connect.role).toBe("operator");
            invalidate(deviceId, {
              role: "operator",
              reason: "cold import authority revoked",
            });
            expect(settled).toBe(false);
            expect(runtime.isAvailable()).toBe(true);
          } else {
            closing = harness.server.close({
              reason: "cold library import shutdown",
              drainTimeoutMs: 0,
            });
            await withinTest(
              awaitGateBeforeSettlement(
                drainEntered.promise,
                closing,
                "Gateway skipped received-work drain",
              ),
              signal,
            );
            expect(kernel.connectionWork.signal.aborted).toBe(true);
            expect(runtime.isAvailable()).toBe(true);
            expect(settled).toBe(false);
            expect(order).toEqual([]);
          }
          release();
          await withinTest(
            awaitGateBeforeSettlement(
              importCompleted.promise,
              requestExecution!,
              "Native import failed to load after release",
            ),
            signal,
          );
          await withinTest(requestExecution!, signal);
          expect(backendEntered).toHaveBeenCalledTimes(mode === "revocation" ? 0 : 1);
          expect(settled).toBe(true);
          expect(order[0]).toBe("request settled");
          closing ??= harness.server.close({
            reason: "cold library import proof complete",
            drainTimeoutMs: 0,
          });
          await withinTest(closing, signal);
          expect(order).toEqual(["request settled", "dependencies stopped"]);
          expect(runtime.isAvailable()).toBe(false);
          expect(kernel.connectionWork.hasPendingWork).toBe(false);
        } finally {
          release();
          await Promise.allSettled([requestExecution, closing]);
          vi.doUnmock("../skills/library/import.js");
          vi.restoreAllMocks();
          signal.removeEventListener("abort", release);
        }
      },
    );
  });
}
