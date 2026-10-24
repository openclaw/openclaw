import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as githubRecords from "../agents/github-oauth-records.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as userGitHubConnections from "../state/user-github-connections.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
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
import { createPersonalGitHubOAuthLifecycle } from "./github-personal-oauth.js";

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
  await githubRecords.writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
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
    // The durable refresh claim commits before dispatch and may arm a reconcile wake first.
    await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledOnce());

    await githubRecords.writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    await time.advanceBy(5 * 60_000);
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(maintainPersonal).toHaveBeenCalledOnce();

    personal.resolve();
    await initialWake;
    await lifecycle.stop();
    await githubRecords.writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    await time.advanceBy(60_000);
    expect(refreshToken).toHaveBeenCalledTimes(2);
  } finally {
    personal.resolve();
    await initialWake;
    await lifecycle.stop();
  }
});

it("skips empty OAuth inventories until a committed write makes work available", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-github-empty-oauth-"));
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  openOpenClawStateDatabase();
  const devices = vi.spyOn(githubRecords, "listGitHubDeviceAuthorizationRecords");
  const records = vi.spyOn(githubRecords, "listGitHubOAuthRecords");
  const time = createGatewaySchedulerClock(NOW);
  const lifecycle = createGitHubOAuthLifecycle({
    getConfig: () => configForScope("system"),
    warn: vi.fn(),
    scheduler: createTestGatewayScheduler(time.clock),
  });
  vi.spyOn(lifecycle.personal, "maintain").mockResolvedValue(undefined);
  try {
    await lifecycle.maintain();
    await lifecycle.maintain();
    expect(devices).toHaveBeenCalledOnce();
    expect(records).toHaveBeenCalledOnce();

    await githubRecords.writeGitHubOAuthRecord(oauthRecord(OLD_PROFILE));
    await lifecycle.maintain();
    expect(devices).toHaveBeenCalledTimes(2);
    expect(records).toHaveBeenCalledTimes(2);
    expect(await githubRecords.inspectGitHubOAuthRecord(OLD_PROFILE)).toEqual({ state: "missing" });
  } finally {
    await lifecycle.stop();
  }
});

it("resumes personal maintenance after a connection write and retains its expiry work", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-github-empty-personal-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const owner = (await ensureCanonicalUserProfileForEmail("oauth-maintenance@example.test")).id;
  const records = vi.spyOn(userGitHubConnections, "listUserGitHubConnectionsAsync");
  const lifecycle = createPersonalGitHubOAuthLifecycle();
  try {
    await lifecycle.maintain();
    await lifecycle.maintain();
    expect(records).toHaveBeenCalledOnce();

    await userGitHubConnections.mutateUserGitHubConnection(
      owner,
      {
        kind: "start",
        requestId: "11111111-1111-4111-8111-111111111111",
        createdAtMs: NOW,
        expiresAtMs: NOW + 60_000,
      },
      () => {},
    );
    await lifecycle.maintain();
    expect(records).toHaveBeenCalledTimes(2);
    expect(
      (await userGitHubConnections.readUserGitHubConnectionAsync(owner))?.pending,
    ).toBeDefined();

    clock.mockReturnValue(NOW + 60_001);
    await lifecycle.maintain();
    expect(records).toHaveBeenCalledTimes(3);
    expect(
      (await userGitHubConnections.readUserGitHubConnectionAsync(owner))?.pending,
    ).toBeUndefined();
  } finally {
    await lifecycle.stop();
  }
});
