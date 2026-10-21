import { expect, it } from "vitest";
import { markAuthProfileSuccess } from "../agents/auth-profiles/profiles.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { markAuthProfileFailure } from "../agents/auth-profiles/usage.js";
import { markEmbeddedRunAuthProfileSuccess } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { readClosedDatabase } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("settles accepted auth bookkeeping across the close prelude and refuses new usage", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-auth-usage-close", signal);
  const { fixture, kernel } = race;
  let queuedFailure: Promise<void> | undefined;
  race.onCleanup(() => queuedFailure?.catch(() => {}));
  try {
    const profileId = "fixture:accepted-close";
    const store: AuthProfileStore = {
      version: 1,
      profiles: { [profileId]: { type: "token", provider: "fixture", token: "synthetic-token" } },
      usageStats: { [profileId]: { errorCount: 3, cooldownUntil: Date.now() + 60_000 } },
    };
    saveAuthProfileStore(store, undefined, { syncExternalCli: false });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const recording = probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (command.type === "authProfiles.usage") {
        await race.block();
      }
      return scope.execute(command, executeOptions);
    });
    race.onCleanup(() => recording.mockRestore());
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
    await race.waitForEntry();
    queuedFailure = inGateway(() =>
      markAuthProfileFailure({ store, profileId, reason: "timeout" }),
    );
    void queuedFailure.catch(() => undefined);
    await race.close(kernel.scheduler.signal, undefined, { reason: "auth usage close" });
    await expect(
      inGateway(() => markAuthProfileSuccess({ store, profileId, provider: "fixture" })),
    ).rejects.toThrow("Auth profile usage owner is closed");
    expect(race.closed).toBe(false);
    expect(shared.isOpen).toBe(true);

    await race.finish();
    await queuedFailure;
    expect(shared.isOpen).toBe(false);
    const [row] = readClosedDatabase(
      resolveOpenClawStateSqlitePath(fixture.state.env),
      "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.state'",
    );
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
    await race.dispose();
  }
});
