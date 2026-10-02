import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { ClawRemoveGatewayBridge } from "./gateway-remove-bridge.js";
import { runClawRemoveCli } from "./gateway-remove-cli.js";
import { readAttachedCronJobsInDatabase } from "./lifecycle-delete-support.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { buildClawRemovePlan } from "./lifecycle-state.js";
import { createClawRemoveTestFixtures } from "./lifecycle-state.test-helpers.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "claw-remove-cli-bridge-",
    env: { OPENCLAW_TEST_RUNTIME_LOG: "1" },
  });
  await state.writeConfig({});
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { addFixture } = createClawRemoveTestFixtures(tempDirs, () => state);

async function readPersistedConfig(): Promise<OpenClawConfig> {
  return JSON.parse(await readFile(state.configPath, "utf8")) as OpenClawConfig;
}

function bridge(input: {
  authorized: () => boolean;
  onQuiesce?: () => void;
}): ClawRemoveGatewayBridge {
  return {
    agentId: "worker",
    assertCurrent: () => {
      if (!input.authorized()) {
        throw new Error("Gateway removal authority retired.");
      }
    },
    allowedCronJobIds: new Set(),
    createCallbacks: (assertCurrent) => ({
      monitorGateway: {
        inspect: async () => {
          assertCurrent();
          return [];
        },
        quiesce: async () => {
          assertCurrent();
          input.onQuiesce?.();
        },
        drain: async () => {
          assertCurrent();
        },
      },
      packageGateway: async () => {
        assertCurrent();
        return { packages: [] };
      },
      cronGateway: {
        get: async () => {
          assertCurrent();
          return null;
        },
        remove: async () => {
          assertCurrent();
        },
      },
    }),
  };
}

describe("Gateway-owned Claw Remove CLI child", () => {
  it("rechecks a config-owned monitor through the serving Gateway without removing it", async () => {
    const current = await addFixture({ withFile: true });
    const database = openOpenClawStateDatabase({ env: current.env });
    upsertCronJobRow(
      database.db,
      "default",
      {
        id: "review-monitor",
        declarationKey: "skill-collection-review:worker",
        name: "skill-collection-review-worker",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        agentId: "worker",
        schedule: { kind: "every", everyMs: 604_800_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Review the skill collection." },
        state: {},
      },
      0,
    );
    const [monitor] = readAttachedCronJobsInDatabase(database.db, "worker");
    if (
      !monitor?.revision ||
      monitor.agentId !== "worker" ||
      monitor.ownerAgentId !== null ||
      !monitor.declarationKey
    ) {
      throw new Error("expected config-owned review monitor");
    }
    const inspected = {
      ...monitor,
      agentId: monitor.agentId,
      ownerAgentId: null,
      declarationKey: monitor.declarationKey,
      revision: monitor.revision,
    };
    const reviewed = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
      exactAgentId: true,
      monitorGateway: { ...quiescentClawMonitorGateway, inspect: async () => [inspected] },
    });
    expect(reviewed.blockers).toEqual([]);
    expect(reviewed.actions).toContainEqual(
      expect.objectContaining({ kind: "scheduledJob", id: "review-monitor", action: "remove" }),
    );

    const offline = await runClawRemoveCli({ agentId: "worker" });
    expect(offline.code).toBe(1);
    expect(offline.payload).toMatchObject({ blockers: [{ code: "agent_job_attached" }] });

    const rechecked = await runClawRemoveCli({
      agentId: "worker",
      gatewayBridge: {
        previewOnly: true,
        agentId: "worker",
        assertCurrent: () => {},
        monitorGateway: { inspect: async () => [inspected] },
      },
    });
    expect(rechecked.code).toBe(0);
    expect(rechecked.payload).toMatchObject({
      planIntegrity: reviewed.planIntegrity,
      blockers: [],
    });
    expect(readAttachedCronJobsInDatabase(database.db, "worker")).toHaveLength(1);
    expect((await readPersistedConfig()).agents?.entries?.worker).toBeDefined();
  }, 120_000);

  it("completes an unchanged removal through the private child bridge", async () => {
    const current = await addFixture({ withFile: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
      exactAgentId: true,
      monitorGateway: quiescentClawMonitorGateway,
    });

    const applied = await runClawRemoveCli({
      agentId: "worker",
      planIntegrity: plan.planIntegrity,
      gatewayBridge: bridge({ authorized: () => true }),
    });

    expect(applied.code).toBe(0);
    expect(applied.payload).toMatchObject({ status: "complete", agentRemoved: true });
    expect((await readPersistedConfig()).agents?.entries?.worker).toBeUndefined();
  }, 120_000);

  it("keeps config when the serving owner retires during the child monitor callback", async () => {
    const current = await addFixture({ withFile: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
      exactAgentId: true,
      monitorGateway: quiescentClawMonitorGateway,
    });
    let authorized = true;

    await expect(
      runClawRemoveCli({
        agentId: "worker",
        planIntegrity: plan.planIntegrity,
        gatewayBridge: bridge({
          authorized: () => authorized,
          onQuiesce: () => {
            authorized = false;
          },
        }),
      }),
    ).rejects.toThrow("The Claw removal command did not complete.");

    expect(authorized).toBe(false);
    expect((await readPersistedConfig()).agents?.entries?.worker).toBeDefined();
  }, 120_000);
});
