import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeGitHubOAuthRecord } from "../agents/github-oauth-records.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createGitHubOAuthLifecycle } from "./github-oauth-lifecycle.js";
import {
  configForScope,
  identity,
  NOW,
  oauthRecord,
  OLD_PROFILE,
} from "./github-oauth-lifecycle.test-support.js";

const refreshToken = vi.hoisted(() => vi.fn());
vi.mock("../agents/github-oauth-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/github-oauth-client.js")>()),
  refreshGitHubOAuthToken: refreshToken,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("refreshes once after sleep while personal maintenance is pending, then stops scheduling", async () => {
  closeOpenClawStateDatabaseForTest();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-github-oauth-scheduling-"));
  const time = createGatewaySchedulerClock(NOW);
  vi.spyOn(Date, "now").mockImplementation(time.clock.now);
  const config = configForScope("system", identity(OLD_PROFILE, { oauth: true }));
  writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
  const scheduled = createDeferredCore();
  const scheduler = createTestGatewayScheduler({
    ...time.clock,
    arm: (run, delayMs) => {
      const cancel = time.clock.arm(run, delayMs);
      if (delayMs > 0) {
        scheduled.resolve();
      }
      return cancel;
    },
  });
  refreshToken.mockResolvedValue({ status: "error", code: "device_flow_disabled" });
  const lifecycle = createGitHubOAuthLifecycle({
    getConfig: () => config,
    warn: vi.fn(),
    scheduler,
  });
  const personal = createDeferredCore();
  const maintainPersonal = vi
    .spyOn(lifecycle.personal, "maintain")
    .mockReturnValue(personal.promise);

  lifecycle.start();
  const initialWake = time.wake();
  try {
    await scheduled.promise;
    expect(refreshToken).toHaveBeenCalledOnce();

    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    await time.advanceBy(5 * 60_000);
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(maintainPersonal).toHaveBeenCalledOnce();

    personal.resolve();
    await initialWake;
    await lifecycle.stop();
    writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    await time.advanceBy(60_000);
    expect(refreshToken).toHaveBeenCalledTimes(2);
  } finally {
    personal.resolve();
    await initialWake;
    await lifecycle.stop();
  }
});
