import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createContext } from "../server-methods/sessions.abort-agent-scope.test-support.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import * as demand from "./device-placement-demand.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { ACTIVE_PLACEMENT } from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";

type Environment = NonNullable<ReturnType<WorkerEnvironmentService["get"]>>;
type Admission = Parameters<typeof beginSessionWorkAdmission>[0];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createFixture() {
  const root = tempDirs.make("openclaw-device-placement-demand-");
  const config = { session: { store: path.join(root, "{agentId}", "sessions.json") } };
  const context = createContext({ extra: { getRuntimeConfig: () => config } });
  const resolveGatewayContext = vi.fn<GatewayContextResolver>(() => context);
  const placement = { ...ACTIVE_PLACEMENT, environmentId: "worker:session-1" };
  const scope = resolveSessionStorePathForScope(placement, config);
  const environment: Environment = {
    ...createDispatchEnvironmentFixtures().attached,
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
    attachedSessionIds: [placement.sessionId],
    providerId: DEVICE_WORKER_PROVIDER_ID,
    nodeDeviceId: "node-1",
  };
  const environments = new Map([[environment.environmentId, environment]]);
  const placements: Pick<WorkerSessionPlacementStore, "getMany" | "getManyAsync"> = {
    getMany: (ids: readonly string[]) =>
      new Map(ids.includes(placement.sessionId) ? [[placement.sessionId, placement]] : []),
    getManyAsync: async (ids) => placements.getMany(ids),
  };
  const writeSession = (storePath = scope, sessionId = placement.sessionId) =>
    replaceSessionEntrySync(
      { ...placement, storePath, env: { OPENCLAW_STATE_DIR: root } },
      { sessionId, updatedAt: 1 },
    );
  const sources = { resolveGatewayContext, placements, environments };
  writeSession();
  const admit = async (
    options: Partial<Pick<Admission, "scope" | "identities" | "resolveGatewayContext">> = {},
  ) => {
    const lease = await beginSessionWorkAdmission({
      scope,
      identities: [placement.sessionKey, placement.sessionId],
      resolveGatewayContext,
      ...options,
      assertAllowed: () => {},
    });
    onTestFinished(() => lease.release());
    return lease;
  };
  return {
    ...sources,
    admit,
    placement,
    environment,
    read: demand.createDevicePlacementDemandReaderAsync(sources),
    readSync: demand.createDevicePlacementDemandReader(sources),
    root,
    writeSession,
  };
}

let fixture: ReturnType<typeof createFixture>;
beforeEach(() => {
  fixture = createFixture();
});
it("counts one session through overlapping admissions and removes it after the final release", async () => {
  const { placement } = fixture;
  expect((await fixture.read()).size).toBe(0);

  const first = await fixture.admit();
  const second = await fixture.admit({
    identities: [placement.sessionId, placement.sessionKey, placement.sessionId],
  });
  expect(await fixture.read()).toEqual(new Map([["node-1", 1]]));
  expect(fixture.readSync()).toEqual(new Map([["node-1", 1]]));
  first.release();
  expect(await fixture.read()).toEqual(new Map([["node-1", 1]]));
  second.release();
  expect((await fixture.read()).size).toBe(0);
});

it.each(["gateway", "scope", "session", "identities"] as const)(
  "does not borrow a matching-looking admission with mismatched %s",
  async (mismatch) => {
    const scope = path.join(fixture.root, "other", "sessions.json");
    if (mismatch === "session") {
      fixture.writeSession(scope, "replaced-session");
    }
    if (mismatch === "identities") {
      await fixture.admit({ identities: [fixture.placement.sessionKey, "other-session"] });
    }
    await fixture.admit({
      ...(mismatch === "gateway" ? { resolveGatewayContext: () => undefined } : {}),
      ...(["scope", "session"].includes(mismatch) ? { scope } : {}),
      ...(mismatch === "identities"
        ? { identities: ["agent:main:other", fixture.placement.sessionId] }
        : {}),
    });

    expect((await fixture.read()).size).toBe(0);
  },
);

it.each(["admission", "gateway"] as const)(
  "rechecks captured %s ownership after reading placements",
  async (owner) => {
    const lease = await fixture.admit();
    fixture.placements.getManyAsync = async (ids) => {
      if (owner === "admission") {
        lease.release();
      } else {
        fixture.resolveGatewayContext.mockReturnValue(createContext());
      }
      return fixture.placements.getMany(ids);
    };

    expect((await fixture.read()).size).toBe(0);
  },
);

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
    const { environment } = fixture;
    await fixture.admit();
    expect(await fixture.read()).toEqual(new Map([["node-1", 1]]));
    fixture.environments.set(environment.environmentId, { ...environment, ...patch });

    expect((await fixture.read()).size).toBe(0);
  },
);
