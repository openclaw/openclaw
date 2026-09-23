import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  completeGatewayBootLifecycle,
  inspectGatewayCrashLoopBreaker,
  recordGatewayBootStart,
} from "./gateway-boot-lifecycle.js";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "./startup-maintenance-required.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("media persistence gateway lifecycle recovery", () => {
  it("leaves maintenance completion to Doctor after a successful media migration", async () => {
    const stateDir = tempDirs.make("media-persistence-startup-recovery-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 14 });

    const nowMs = 1_000_000;
    for (let index = 0; index < 3; index += 1) {
      const bootId = recordGatewayBootStart(env, nowMs + index);
      completeGatewayBootLifecycle(
        bootId,
        {
          outcome: "startup_failed",
          reason: `migration required ${index}`,
          startupReason: GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON,
        },
        env,
        nowMs + index + 1,
      );
    }
    expect(inspectGatewayCrashLoopBreaker(env, nowMs + 4).tripped).toBe(false);

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare(
          "SELECT COUNT(*) AS count FROM gateway_boot_lifecycle WHERE outcome = 'startup_failed'",
        )
        .get(),
    ).toMatchObject({ count: 3 });
    expect(inspectGatewayCrashLoopBreaker(env, nowMs + 5)).toMatchObject({
      tripped: false,
      uncleanBoots: 0,
    });
  });
});
