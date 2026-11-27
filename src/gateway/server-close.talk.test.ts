import "./server-startup-module-mocks.test-support.js";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withClientVoiceSessionSettlement } from "../talk/client-voice-session-lifecycle.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { isGatewayCleanupRetainedError, runGatewayCloseSteps } from "./server-shutdown.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { activate, createControlFixture } from "./talk/client-control-fixture.test-support.js";

it.for([true, false])(
  "bounds Talk teardown (exitAfterClose=%s)",
  async (exitAfterClose, { signal }) => {
    const fixture = await createGatewayMetadataCloseFixture("talk-close-budget");
    const release = createDeferredCore();
    let draining: Promise<unknown> | undefined;
    let prepare: Promise<unknown> | undefined;
    const providerClosing = createDeferredCore();
    const onError = vi.fn();
    try {
      const { kernel } = await fixture.startServer();
      const closeMcp = vi.spyOn(kernel.shutdownRuntime, "closeMcpLoopbackServer");
      const client = createOperatorWsClient();
      kernel.clients.add(client);
      const control = createControlFixture({
        connId: client.connId,
        voiceSessionId: "voice-shutdown-budget",
        withCloseSettlement: withClientVoiceSessionSettlement,
      });
      await activate(control.owner, async () => {
        providerClosing.resolve();
        await release.promise;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const prepared = kernel.prepareClose({ exitAfterClose });
      prepare = prepared;
      await withinTest(providerClosing.promise, signal);
      // Preparation must return the plan while the provider still owns final speech.
      const close = await withinTest(prepared, signal);
      // Exercise exit grace and Talk's embedded timeout. Final resource retirement
      // has separate coverage and must retain unfinished writes.
      draining = runGatewayCloseSteps({
        owner: kernel,
        exitAfterClose,
        close: async () => {},
        onError,
      }).catch((error: unknown) => error);
      expect(closeMcp).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(exitAfterClose ? 5_001 : 60_001);
      const error = await withinTest(draining, signal);
      expect(isGatewayCleanupRetainedError(error)).toBe(true);
      if (exitAfterClose) {
        expect(onError).toHaveBeenCalledWith(
          expect.stringMatching(/gateway close prelude cleanup exceeded 5000ms.*talk-persistence/),
        );
      } else {
        expect(closeMcp).toHaveBeenCalledOnce();
      }
      expect(control.flushTranscript).not.toHaveBeenCalled();
      release.resolve();
      vi.useRealTimers();
      await control.owner.close();
      expect(control.flushTranscript).toHaveBeenCalledOnce();
      await close();
    } finally {
      release.resolve();
      vi.useRealTimers();
      await Promise.allSettled([prepare, draining]);
      await fixture.cleanup();
      vi.restoreAllMocks();
    }
  },
);
