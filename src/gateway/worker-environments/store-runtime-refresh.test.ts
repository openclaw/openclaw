import { beforeEach, describe, expect, it } from "vitest";
import type { WorkerDesktopEndpoint } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createEnvironmentStoreFixture } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const DESKTOP: WorkerDesktopEndpoint = {
  protocol: "rfb",
  port: 5900,
  passwordFilePath: "/vnc.password",
  apps: [
    { id: "browser", executablePath: "/browser", cdpPort: 9222 },
    { id: "terminal", executablePath: "/terminal" },
  ],
};

describe("worker environment runtime refresh", () => {
  const environmentId = "worker-refresh";
  const sessionId = REQUEST.sessionId;
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let nowMs: number;
  const {
    bootstrapReceipt: BOOTSTRAP_RECEIPT,
    createIntent,
    seedBootstrapping,
    readyPatch,
    attachedPatch,
  } = createEnvironmentStoreFixture({
    getStore: () => store,
    getDatabase: () => database,
    now: () => nowMs,
  });

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worker-env-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  const replacement = {
    ...BOOTSTRAP_RECEIPT,
    bundleHash: "c".repeat(64),
    openclawVersion: "2026.7.2",
    protocolFeatures: BOOTSTRAP_RECEIPT.protocolFeatures.toSorted(),
  };

  const snapshot = (placements: ReturnType<typeof createWorkerSessionPlacementStore>) => [
    store.get(environmentId),
    placements.get(sessionId),
  ];

  async function seedRefresh(state: "idle" | "attached", transport: "node" | "ssh" = "node") {
    if (transport === "ssh") {
      await seedBootstrapping(environmentId, "lease-refresh");
    } else {
      await createIntent(environmentId);
      await store.transition({ environmentId, from: "requested", to: "provisioning" });
    }
    await store.transition({
      environmentId,
      from: transport === "ssh" ? "bootstrapping" : "provisioning",
      to: "ready",
      patch: {
        ...readyPatch(),
        ...(transport === "node"
          ? { leaseId: "lease-refresh", nodeDeviceId: "node-refresh", desktop: DESKTOP }
          : {}),
      },
    });
    await store.transition({
      environmentId,
      from: "ready",
      to: state,
      ...(state === "attached" ? { patch: attachedPatch(sessionId, "refresh") } : {}),
    });
    let environment = store.get(environmentId)!;
    const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const placement =
      state === "attached"
        ? await seedActivePlacement(placements, {
            environmentId,
            ownerEpoch: environment.ownerEpoch,
          })
        : undefined;
    environment = store.get(environmentId)!;
    await store.revokeEnvironmentCredential(environmentId);
    const owner = { environmentId, ownerEpoch: environment.ownerEpoch };
    const input = {
      environmentId,
      expectedOwnerEpoch: environment.ownerEpoch,
      expectedNodeDeviceId: environment.nodeDeviceId,
      expectedBootstrapReceipt: environment.bootstrapReceipt!,
      bootstrapReceipt: replacement,
      assertCurrent: () => {},
      ...(state === "attached"
        ? { expectedState: state, expectedPlacementGeneration: placement!.generation }
        : { expectedState: state }),
    };
    const unchanged = () => expect(snapshot(placements)).toEqual([environment, placement]);
    return { environment, placements, placement, input, owner, unchanged };
  }

  it.each([
    ["idle", "node"],
    ["attached", "node"],
    ["attached", "ssh"],
  ] as const)(
    "refreshes %s %s runtime without replacing its machine or workspace",
    async (state, transport) => {
      const { environment, placements, placement, input } = await seedRefresh(state, transport);
      nowMs += 1_000;
      expect(await store.refreshBootstrapReceipt(input)).toEqual({
        ...environment,
        bootstrapReceipt: replacement,
        updatedAtMs: nowMs,
      });
      expect(store.getCredential(environmentId)).toBeUndefined();
      if (placement) {
        expect(placements.get(sessionId)).toEqual({
          ...placement,
          workerBundleHash: replacement.bundleHash,
          updatedAtMs: nowMs,
        });
      }
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
      expect(store.get(environmentId)?.bootstrapReceipt).toEqual(replacement);
      if (placement) {
        expect(
          await createWorkerSessionPlacementStore({ database }).getAsync(sessionId),
        ).toMatchObject({
          workerBundleHash: replacement.bundleHash,
          activeOwnerEpoch: placement.activeOwnerEpoch,
          remoteWorkspaceDir: placement.remoteWorkspaceDir,
        });
      }
    },
  );

  it("rejects stale refresh identity and renewed credentials without changing either receipt", async () => {
    const { environment, placement, input, unchanged } = await seedRefresh("attached");
    const staleInputs = [
      { expectedOwnerEpoch: input.expectedOwnerEpoch + 1 },
      { expectedNodeDeviceId: "node-replaced" },
      { expectedBootstrapReceipt: { ...BOOTSTRAP_RECEIPT, openclawVersion: "2026.6.1" } },
      { expectedBootstrapReceipt: { ...BOOTSTRAP_RECEIPT, protocolFeatures: [] } },
      {
        expectedState: "attached" as const,
        expectedPlacementGeneration: placement!.generation + 1,
      },
      {
        assertCurrent: () => {
          throw new Error("Worker turn acquired live authority");
        },
      },
    ];
    for (const stale of staleInputs) {
      await expect(store.refreshBootstrapReceipt({ ...input, ...stale })).rejects.toThrow();
      unchanged();
    }
    await store.renewCredential({
      ...attachedPatch(sessionId, "renewed").credential,
      environmentId,
      expectedOwnerEpoch: environment.ownerEpoch,
    });
    await expect(store.refreshBootstrapReceipt(input)).rejects.toThrow(
      "previous credential to be revoked",
    );
    unchanged();
  });

  it("rolls back the placement receipt when the environment write fails", async () => {
    const { input, unchanged } = await seedRefresh("attached");
    database.db.exec(`CREATE TRIGGER reject_runtime_receipt
      BEFORE UPDATE OF bootstrap_bundle_hash ON worker_environments
      BEGIN SELECT RAISE(ABORT, 'runtime receipt write failed'); END`);
    await expect(store.refreshBootstrapReceipt(input)).rejects.toThrow(
      "runtime receipt write failed",
    );
    unchanged();
    database.db.exec("DROP TRIGGER reject_runtime_receipt");
    expect((await store.refreshBootstrapReceipt(input)).bootstrapReceipt).toEqual(replacement);
  });

  it.each(["draining", "moving", "destroying"] as const)(
    "does not refresh an owner that is %s",
    async (operation) => {
      const { owner, placements, placement, input } = await seedRefresh("attached");
      if (operation === "destroying") {
        await store.requestDestroy({ environmentId, state: "attached" });
      } else if (operation === "moving") {
        await placements.beginPlacementMove({
          sessionId,
          source: { ...owner, generation: placement!.generation },
          target: { kind: "gateway" },
        });
      } else {
        await placements.startDrain({
          ...owner,
          sessionId,
          expectedGeneration: placement!.generation,
        });
      }
      const before = snapshot(placements);
      await expect(store.refreshBootstrapReceipt(input)).rejects.toThrow();
      expect(snapshot(placements)).toEqual(before);
    },
  );

  it("hands off the pending result while preserving its recovery-only claim", async () => {
    const { owner, placements, input } = await seedRefresh("attached");
    const claim = await placements.claimTurn({
      ...REQUEST,
      claimId: "interrupted-claim",
      runId: "interrupted-run",
      owner: { ...owner, kind: "worker" },
    });
    await placements.markWorkspaceResultPending(claim);
    const pending = await placements.listPendingWorkspaceResultsAsync();
    const beforePlacement = placements.get(sessionId);
    const binding = { ...owner, sessionId };
    const liveGate = createWorkerSessionPlacementGate(placements);
    await expect(liveGate.prepareWorkerRuntimeRefresh(binding)).rejects.toThrow("current turn");
    const recoveryGate = createWorkerSessionPlacementGate(placements, {
      recoveryPlacements: await placements.listAsync(),
    });
    const refresh = await recoveryGate.prepareWorkerRuntimeRefresh(binding);
    try {
      await store.refreshBootstrapReceipt({ ...input, assertCurrent: refresh.assertCurrent });
    } finally {
      refresh.release();
    }
    expect(placements.get(sessionId)).toEqual({
      ...beforePlacement,
      workerBundleHash: replacement.bundleHash,
    });
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([
      { ...pending[0], recoveryRequestedAtMs: nowMs },
    ]);
    await placements.prepareWorkspaceResultClaim(claim);
    expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
    expect(recoveryGate.validateWorkerTurn(claim)).toBe(false);
    expect(store.getCredential(environmentId)).toBeUndefined();
  });
});
