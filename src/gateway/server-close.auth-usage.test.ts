import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { markAuthProfileSuccess } from "../agents/auth-profiles/profiles.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { markAuthProfileFailure } from "../agents/auth-profiles/usage.js";
import { markEmbeddedRunAuthProfileSuccess } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles accepted auth bookkeeping across the close prelude and refuses new usage", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-auth-usage-close");
  const recordingEntered = createDeferred();
  const releaseRecording = createDeferred();
  const preludeEntered = createDeferred();
  let closing: Promise<void> | undefined;
  let queuedFailure: Promise<void> | undefined;
  let restoreRecording: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const profileId = "fixture:accepted-close";
    const store: AuthProfileStore = {
      version: 1,
      profiles: { [profileId]: { type: "token", provider: "fixture", token: "synthetic-token" } },
      usageStats: { [profileId]: { errorCount: 3, cooldownUntil: Date.now() + 60_000 } },
    };
    saveAuthProfileStore(store, undefined, { syncExternalCli: false });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const run = stateWorker.runOpenClawStateWorkerOperation;
    const recording = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "authProfiles.usage") {
                  recordingEntered.resolve();
                  await releaseRecording.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
      );
    restoreRecording = () => recording.mockRestore();
    const inGateway = <T>(operation: () => T) =>
      withPluginRuntimeGatewayContextResolver(kernel.resolvePluginGatewayContext, operation);
    inGateway(() =>
      markEmbeddedRunAuthProfileSuccess({
        profileId,
        profileStore: store,
        provider: "fixture",
        runId: "accepted-close-run",
        sessionId: "accepted-close-session",
      }),
    );
    await withinTest(recordingEntered.promise, signal);
    queuedFailure = inGateway(() =>
      markAuthProfileFailure({ store, profileId, reason: "timeout" }),
    );
    void queuedFailure.catch(() => undefined);
    kernel.scheduler.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    let closed = false;
    closing = server.close({ reason: "auth bookkeeping close regression" }).then(() => {
      closed = true;
    });
    await withinTest(preludeEntered.promise, signal);
    await expect(
      inGateway(() => markAuthProfileSuccess({ store, profileId, provider: "fixture" })),
    ).rejects.toThrow("Auth profile usage owner is closed");
    expect(closed).toBe(false);
    expect(shared.isOpen).toBe(true);

    releaseRecording.resolve();
    await withinTest(closing, signal);
    await queuedFailure;
    expect(shared.isOpen).toBe(false);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      const row = database
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.state'",
        )
        .get();
      expect(JSON.parse(String(row?.value_json))).toMatchObject({
        lastGood: { fixture: profileId },
        usageStats: {
          [profileId]: {
            lastUsed: expect.any(Number),
            errorCount: 1,
            failureCounts: { timeout: 1 },
          },
        },
      });
    } finally {
      database.close();
    }
  } finally {
    releaseRecording.resolve();
    await closing?.catch(() => {});
    await queuedFailure?.catch(() => {});
    restoreRecording?.();
    await fixture.cleanup();
  }
});
