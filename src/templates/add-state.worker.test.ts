import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerLeaseContext } from "../state/openclaw-state-lease-context.js";
import { runWithOpenClawStateLeasesWorker } from "../state/openclaw-state-lease-worker-operation.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { mergeWorkspaceBootstrapSetupStateForAdd } from "./add-state-write.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const bootstrapSeededAt = "2026-10-28T03:00:00.000Z";
const nowMs = Date.parse(bootstrapSeededAt);

type Fixture = {
  workspaceDir: string;
  context: OpenClawStateWorkerContext;
  leases: readonly OpenClawStateWorkerLeaseContext[];
  read: () => ReturnType<typeof readWorkspaceStateSnapshot>;
};

async function withAddLeases(run: (fixture: Fixture) => Promise<void>) {
  const root = dirs.make("template-bootstrap-worker-");
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir);
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  const database = openOpenClawStateDatabase({ env });
  await withExistingOpenClawStateSchema({ path: database.path }, async () => {
    const context = captureOpenClawStateWorkerContext({ env });
    await withOpenClawStateLeaseAsync(
      {
        scope: "core:template-add-allocation",
        key: "bootstrap-worker",
        leaseMs: 60_000,
        waitMs: 0,
        heartbeat: "worker",
      },
      context,
      async (allocation) =>
        withOpenClawStateLeaseAsync(
          {
            scope: "core:agent-deletion",
            key: "bootstrap-worker",
            leaseMs: 60_000,
            waitMs: 0,
            heartbeat: "worker",
          },
          context,
          async (agent) => {
            await Promise.all([allocation.assertOwned(), agent.assertOwned()]);
            await run({
              workspaceDir,
              context,
              leases: [allocation, agent],
              read: () => readWorkspaceStateSnapshot(workspaceDir, { env, readOnly: true }),
            });
          },
        ),
    );
  });
}

it("persists bootstrap setup through the real worker under both live Add leases", async () => {
  await withAddLeases(async (fixture) => {
    await expect(
      mergeWorkspaceBootstrapSetupStateForAdd(fixture.workspaceDir, bootstrapSeededAt, nowMs, {
        stateMode: "worker",
        leaseSet: fixture,
      }),
    ).resolves.toEqual({ version: 1, bootstrapSeededAt });
    expect(await fixture.read()).toMatchObject({
      setupExists: true,
      setup: { version: 1, bootstrapSeededAt },
    });
  });
});

it.each(["missing", "mismatched", "duplicate", "stale"] as const)(
  "refuses %s lease facts without publishing bootstrap setup",
  async (mode) => {
    await withAddLeases(async (fixture) => {
      const mutation = runWithOpenClawStateLeasesWorker(
        fixture.leases,
        fixture.context,
        (scope, identities) => {
          const first = expectDefined(identities[0], "allocation identity");
          const second = expectDefined(identities[1], "agent identity");
          const leases: readonly OpenClawStateLeaseIdentity[] | undefined =
            mode === "missing"
              ? undefined
              : mode === "mismatched"
                ? [second, first]
                : mode === "duplicate"
                  ? [first, first]
                  : [{ ...first, owner: "retired-owner" }, second];
          return scope.execute({
            type: "templates.add.mergeBootstrapSetupState",
            input: {
              workspaceDir: fixture.workspaceDir,
              bootstrapSeededAt,
              nowMs,
              ...(leases ? { leases } : {}),
            },
          });
        },
      );
      if (mode === "duplicate") {
        await expect(mutation).rejects.toThrow("distinct live leases");
      } else {
        await expect(mutation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      }
      expect(await fixture.read()).toMatchObject({ setupExists: false });
    });
  },
);

it("rolls back bootstrap setup when the original caller is revoked at native commit", async () => {
  await withAddLeases(async (fixture) => {
    let current = true;
    const revoked = new Error("Template Add authority retired before commit");
    await expect(
      runWithOpenClawStateLeasesWorker(
        fixture.leases,
        fixture.context,
        (scope, leases) =>
          scope.execute({
            type: "templates.add.mergeBootstrapSetupState",
            input: { workspaceDir: fixture.workspaceDir, bootstrapSeededAt, nowMs, leases },
          }),
        {
          assertCurrent: () => {
            if (!current) {
              throw revoked;
            }
          },
          beforeCommit: () => {
            current = false;
          },
        },
      ),
    ).rejects.toThrow(revoked.message);
    expect(current).toBe(false);
    expect(await fixture.read()).toMatchObject({ setupExists: false });
  });
});
