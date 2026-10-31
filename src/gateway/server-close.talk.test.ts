import "./server-startup-module-mocks.test-support.js";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withClientVoiceSessionSettlement } from "../talk/client-voice-session-lifecycle.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { isGatewayCleanupRetainedError, runGatewayCloseSteps } from "./server-shutdown.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { activate, createControlFixture } from "./talk/client-control-fixture.test-support.js";

it("bounds Talk teardown before a stuck provider can hold the shutdown plan", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("talk-close-budget");
  const release = createDeferredCore();
  let draining: Promise<unknown> | undefined;
  let prepare: Promise<unknown> | undefined;
  const providerClosing = createDeferredCore();
  const onError = vi.fn();
  try {
    const { kernel } = await fixture.startServer();
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
    const prepared = kernel.prepareClose({ exitAfterClose: true });
    prepare = prepared;
    await withinTest(providerClosing.promise, signal);
    // Preparation must return the plan while the provider still owns final speech.
    const close = await withinTest(prepared, signal);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Exercise the real prelude within its process-exit grace. Final resource
    // retirement has its own tests and must retain any unfinished writes.
    draining = runGatewayCloseSteps({
      owner: kernel,
      exitAfterClose: true,
      close: async () => {},
      onError,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_001);
    const error = await withinTest(draining, signal);
    expect(isGatewayCleanupRetainedError(error)).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/gateway close prelude cleanup exceeded 5000ms.*talk-persistence/),
    );
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
});
