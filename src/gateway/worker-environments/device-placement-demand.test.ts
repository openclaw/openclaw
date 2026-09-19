import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { rotateAgentRunRegistryLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createContext } from "../server-methods/sessions.abort-agent-scope.test-support.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { createDevicePlacementDemandReader } from "./device-placement-demand.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { ACTIVE_PLACEMENT } from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerEnvironmentService } from "./service.js";

type ActivePlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;
type Environment = NonNullable<ReturnType<WorkerEnvironmentService["get"]>>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createFixture() {
  const root = tempDirs.make("openclaw-device-placement-demand-");
  const config = { session: { store: path.join(root, "{agentId}", "sessions.json") } };
  const context = createContext({ extra: { getRuntimeConfig: () => config } });
  const resolveGatewayContext = () => context;
  const records = new Map<string, WorkerSessionPlacementRecord>();
  const environments = new Map<string, Environment>();
  const placements = {
    getMany: (ids: readonly string[]) =>
      new Map(
        ids.flatMap((id) => {
          const record = records.get(id);
          return record ? [[id, record] as const] : [];
        }),
      ),
  };
  const writeSession = (
    placement: ActivePlacement,
    storePath = resolveSessionStorePathForScope(placement, config),
    sessionId = placement.sessionId,
  ) =>
    replaceSessionEntrySync(
      {
        storePath,
        agentId: placement.agentId,
        sessionKey: placement.sessionKey,
        env: { OPENCLAW_STATE_DIR: root },
      },
      { sessionId, updatedAt: 1 },
    );
  const read = createDevicePlacementDemandReader({
    resolveGatewayContext,
    placements,
    environments: { get: (id) => environments.get(id) },
  });
  const addPlacement = (sessionId = "session-1", deviceId = "node-1", agentId = "main") => {
    const placement: ActivePlacement = {
      ...ACTIVE_PLACEMENT,
      agentId,
      sessionId,
      sessionKey: `agent:${agentId}:${sessionId}`,
      environmentId: `worker:${sessionId}`,
    };
    const environment: Environment = {
      ...createDispatchEnvironmentFixtures().attached,
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      attachedSessionIds: [placement.sessionId],
      providerId: DEVICE_WORKER_PROVIDER_ID,
      nodeDeviceId: deviceId,
    };
    records.set(sessionId, placement);
    environments.set(environment.environmentId, environment);
    writeSession(placement);
    return { placement, environment };
  };
  const admit = async (
    placement: ActivePlacement,
    options: {
      scope?: string;
      identities?: string[];
      resolveGatewayContext?: GatewayContextResolver;
    } = {},
  ) => {
    const lease = await beginSessionWorkAdmission({
      scope: options.scope ?? resolveSessionStorePathForScope(placement, config),
      identities: options.identities ?? [placement.sessionKey, placement.sessionId],
      resolveGatewayContext: options.resolveGatewayContext ?? resolveGatewayContext,
      assertAllowed: () => {},
    });
    onTestFinished(() => lease.release());
    return lease;
  };
  return { addPlacement, admit, environments, placements, read, records, root, writeSession };
}

describe("admitted device placement demand", () => {
  it("counts one session through overlapping admissions and removes it after the final release", async () => {
    const fixture = createFixture();
    const { placement } = fixture.addPlacement();
    expect(fixture.read().size).toBe(0);

    const first = await fixture.admit(placement);
    const second = await fixture.admit(placement, {
      identities: [placement.sessionId, placement.sessionKey, placement.sessionId],
    });
    expect(fixture.read()).toEqual(new Map([["node-1", 1]]));
    first.release();
    expect(fixture.read()).toEqual(new Map([["node-1", 1]]));
    second.release();
    expect(fixture.read().size).toBe(0);
  });

  it("groups distinct admitted sessions by device across agent stores and excludes the dispatching session", async () => {
    const fixture = createFixture();
    for (const [sessionId, deviceId, agentId] of [
      ["one", "node-1", "main"],
      ["two", "node-1", "ops"],
      ["three", "node-2", "main"],
    ] as const) {
      await fixture.admit(fixture.addPlacement(sessionId, deviceId, agentId).placement);
    }
    fixture.addPlacement("idle", "node-2");

    expect(fixture.read()).toEqual(
      new Map([
        ["node-1", 2],
        ["node-2", 1],
      ]),
    );
    expect(fixture.read("one")).toEqual(
      new Map([
        ["node-1", 1],
        ["node-2", 1],
      ]),
    );
  });

  it.each(["gateway", "scope", "session-key", "session-id"] as const)(
    "does not borrow a matching-looking admission from another %s",
    async (mismatch) => {
      const fixture = createFixture();
      const { placement } = fixture.addPlacement();
      await fixture.admit(placement, {
        ...(mismatch === "gateway" ? { resolveGatewayContext: () => undefined } : {}),
        ...(mismatch === "scope"
          ? { scope: path.join(fixture.root, "other", "sessions.json") }
          : {}),
        ...(mismatch === "session-key"
          ? { identities: ["agent:main:other", placement.sessionId] }
          : mismatch === "session-id"
            ? { identities: [placement.sessionKey, "other-session"] }
            : {}),
      });

      expect(fixture.read().size).toBe(0);
    },
  );

  it("uses the admitted discovered store when its path does not match current configuration", async () => {
    const fixture = createFixture();
    const { placement } = fixture.addPlacement("retired", "node-1", "retired-agent");
    const scope = path.join(fixture.root, "agents", "Retired Agent", "sessions", "sessions.json");
    fixture.writeSession(placement, scope);
    const lease = await fixture.admit(placement, { scope });

    expect(fixture.read()).toEqual(new Map([["node-1", 1]]));
    lease.release();
    expect(fixture.read().size).toBe(0);
  });

  it("rejects an admitted scope whose persisted session row belongs to another session ID", async () => {
    const fixture = createFixture();
    const { placement } = fixture.addPlacement();
    const scope = path.join(fixture.root, "other", "sessions.json");
    fixture.writeSession(placement, scope, "replaced-session");
    await fixture.admit(placement, { scope });

    expect(fixture.read().size).toBe(0);
  });

  it("does not combine different multi-identity admissions into one placement owner", async () => {
    const fixture = createFixture();
    const { placement } = fixture.addPlacement();
    await fixture.admit(placement, { identities: [placement.sessionKey, "other-session"] });
    await fixture.admit(placement, { identities: ["agent:main:other", placement.sessionId] });

    expect(fixture.read().size).toBe(0);
  });

  it("drops admission demand when the Gateway lifecycle rotates", async () => {
    const fixture = createFixture();
    await fixture.admit(fixture.addPlacement().placement);
    expect(fixture.read()).toEqual(new Map([["node-1", 1]]));

    rotateAgentRunRegistryLifecycleGeneration();

    expect(fixture.read().size).toBe(0);
  });

  it("rechecks captured admission ownership after reading placements", async () => {
    const fixture = createFixture();
    const lease = await fixture.admit(fixture.addPlacement().placement);
    const getMany = fixture.placements.getMany;
    fixture.placements.getMany = (ids) => {
      lease.release();
      return getMany(ids);
    };

    expect(fixture.read().size).toBe(0);
  });

  it.each([
    { name: "owner epoch", patch: { ownerEpoch: 2 } },
    { name: "environment identity", patch: { environmentId: "another-environment" } },
    { name: "attached session", patch: { attachedSessionIds: ["another-session"] } },
    { name: "shared attachment", patch: { attachedSessionIds: ["session-1", "another-session"] } },
    { name: "destroy request", patch: { destroyRequestedAtMs: 1 } },
    { name: "environment state", patch: { state: "draining" } },
    { name: "provider", patch: { providerId: "cloud" } },
    { name: "node identity", patch: { nodeDeviceId: null } },
  ] satisfies Array<{ name: string; patch: Partial<Environment> }>)(
    "does not count a placement after its $name changes",
    async ({ patch }) => {
      const fixture = createFixture();
      const { placement, environment } = fixture.addPlacement();
      await fixture.admit(placement);
      expect(fixture.read()).toEqual(new Map([["node-1", 1]]));
      fixture.environments.set(environment.environmentId, { ...environment, ...patch });

      expect(fixture.read().size).toBe(0);
    },
  );

  it("excludes remote-exec work and placements that are draining", async () => {
    const fixture = createFixture();
    const remote = fixture.addPlacement("remote").placement;
    const draining = fixture.addPlacement("draining").placement;
    await fixture.admit(remote);
    await fixture.admit(draining);
    fixture.records.set(remote.sessionId, { ...remote, executionMode: "remote-exec" });
    fixture.records.set(draining.sessionId, { ...draining, state: "draining" });

    expect(fixture.read().size).toBe(0);
  });
});
