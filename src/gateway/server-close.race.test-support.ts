import { expectDefined } from "@openclaw/normalization-core";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

export async function createGatewayCloseRace(label: string, signal: AbortSignal) {
  const fixture = await createGatewayMetadataCloseFixture(label);
  const entered = createDeferred();
  const release = createDeferred();
  const cleanup: Array<() => void | Promise<void>> = [];
  let closing: Promise<void> | undefined;
  let accepted: Promise<unknown> | undefined;
  let closed = false;
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
    return {
      fixture,
      kernel,
      get closed() {
        return closed;
      },
      onCleanup: (run: () => void | Promise<void>) => {
        cleanup.push(run);
      },
      dispatch: <T>(method: string, params: unknown) =>
        dispatchGatewayRequestInProcess<T>(method, params, dispatchOptions),
      async block() {
        entered.resolve();
        await release.promise;
      },
      async waitForEntry(work?: Promise<unknown>, message = "Accepted work bypassed its worker") {
        accepted = work;
        await withinTest(
          work ? awaitGateBeforeSettlement(entered.promise, work, message) : entered.promise,
          signal,
        );
      },
      async close(
        abort = kernel.requestEntryLifetime.signal,
        onAbort = () => {},
        options: Parameters<typeof server.close>[0] = {
          reason: "gateway restarting",
          restartExpectedMs: 1_500,
        },
      ) {
        const prelude = createDeferred();
        abort.addEventListener(
          "abort",
          () => {
            onAbort();
            prelude.resolve();
          },
          { once: true },
        );
        closing = server.close(options).then(() => {
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
      },
      async finish<T>(work?: Promise<T>) {
        release.resolve();
        const [result] = await withinTest(Promise.all([work, closing]), signal);
        return result;
      },
      async dispose() {
        release.resolve();
        await Promise.allSettled([accepted, closing]);
        for (const run of cleanup) {
          await run();
        }
        await fixture.cleanup();
      },
    };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}
