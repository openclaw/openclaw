import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRequestGate } from "../server-methods.request-gate.test-support.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { commandsHandlers } from "./commands.js";
import { withSessionDiscoveryAccess } from "./session-discovery-access.js";
import { handleSkillsStatus } from "./skills-status.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const { discovery } = vi.hoisted(() => ({ discovery: vi.fn(async () => {}) }));
// Library storage, workspace discovery, and exec-policy storage have separate owners.
// mock-isolation: Discovery authority tests isolate exec-policy storage from the session authorization boundary.
vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibilityAsync: () => ({ canExec: false }),
}));
vi.mock("../../skills/discovery/chat-commands.js", () => ({
  prepareSkillCommandsForAgents: vi.fn(async () => {
    await discovery();
    return [];
  }),
}));
vi.mock("../../skills/discovery/status.js", () => ({
  prepareWorkspaceSkillStatus: vi.fn(async () => {
    await discovery();
    return { report: { skills: [] }, files: [] };
  }),
}));

afterEach(() => vi.restoreAllMocks());

const sessionKey = "agent:main:discovery";
const scope = { agentId: "main", sessionKey };
const sessionEntry = {
  sessionId: "discovery",
  updatedAt: 1,
  visibility: "read-only",
  createdActor: { type: "human", source: "profile", id: "owner" },
} as const;
const handlers = {
  "commands.list": commandsHandlers["commands.list"]!,
  "skills.status": handleSkillsStatus,
};

function participant(): GatewayClient {
  return {
    connect: gatewayConnect(["operator.read", "operator.write"]),
    authenticatedUserProfile: gatewayProfile("alice", "Alice"),
    preparedSessionProfile: { profileId: "alice", aliases: new Set(["alice"]), role: null },
  };
}

async function withDiscoveryState(
  consume: (fixture: {
    projection: Awaited<ReturnType<typeof createSessionRowProjection>>;
    context: GatewayRequestContext;
    setConfig: (cfg: OpenClawConfig) => void;
    call: (
      method: keyof typeof handlers,
      client?: GatewayClient,
      hasCurrentClientAuthority?: () => boolean,
    ) => Promise<Parameters<RespondFn>>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    let cfg: OpenClawConfig = {
      plugins: { enabled: false },
      skills: { load: { watch: false } },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    setRuntimeConfigSnapshot(cfg);
    await seed();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      const context = bindSessionRowProjection(
        { getRuntimeConfig: () => cfg } as GatewayRequestContext,
        () => projection,
      );
      await consume({
        context,
        projection,
        setConfig: (value) => {
          cfg = value;
          setRuntimeConfigSnapshot(cfg);
        },
        async call(method, client, hasCurrentClientAuthority) {
          const responses: Parameters<RespondFn>[] = [];
          await handlers[method]({
            req: { type: "req", id: method, method },
            params: { sessionKey, agentId: "main" },
            client: client ?? participant(),
            context,
            hasCurrentClientAuthority,
            isWebchatConnect: () => true,
            respond: (...response) => responses.push(response),
          });
          expect(responses).toHaveLength(1);
          return responses[0]!;
        },
      });
    } finally {
      projection.dispose();
    }
  });
}

async function seed() {
  await upsertSessionEntryCore(scope, sessionEntry);
  addSessionMember(scope, { identityId: "alice", addedBy: "owner" });
}

it.each(["commands.list", "skills.status"] as const)(
  "%s discovers for a participant before and after topology invalidation without caller-thread SQL",
  async (method) => {
    await withDiscoveryState(async ({ call }) => {
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      try {
        expect((await call(method))[0]).toBe(true);
        sessionChanges.emit({ all: true, scope: "stores" });
        expect((await call(method))[0]).toBe(true);
        expect.soft(prepare).not.toHaveBeenCalled();
        expect.soft(exec).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
    });
  },
);

it.each(["commands.list", "skills.status"] as const)(
  "%s refuses authority revoked during discovery",
  async (method) => {
    await withDiscoveryState(async ({ call, projection, context, setConfig }) => {
      const cfg = context.getRuntimeConfig();
      for (const change of [
        "member",
        "dirty",
        "callback-dirty",
        "profile",
        "policy",
        "projection",
        "run",
        "request",
        "session",
        "route",
      ] as const) {
        setConfig(cfg);
        bindSessionRowProjection(context, () => projection);
        await seed();
        await projection.prepareMembership();
        const client = participant();
        let revoked = false;
        if (change === "run") {
          client.internal = {
            syntheticClient: true,
            operatorRoleActor: { kind: "operator", profileId: "alice" },
            operatorRunAuthority: createAdmittedRunOperatorAuthority({
              profileId: "alice",
              scopes: ["operator.read", "operator.write"],
              assertCurrent: () => {
                if (revoked) {
                  throw new Error("discovery run revoked");
                }
              },
            }),
          };
        }
        using gate = createRequestGate();
        discovery.mockImplementationOnce(gate.pause);
        const invalidateMembership = () => {
          const target = projection.sharingTarget({ key: sessionKey, agentId: "main" })!;
          sessionChanges.emit({ all: true, scope: "stores" });
          expect(projection.hasMembership(target.storePath, target.storeKey, "alice")).toBe(true);
          expect(projection.sharingTargetState({ key: sessionKey, agentId: "main" }).status).toBe(
            "pending",
          );
        };
        let dirtyOnCheck = false;
        const pending = call(method, client, () => {
          if (dirtyOnCheck) {
            dirtyOnCheck = false;
            invalidateMembership();
          }
          return change !== "request" || !revoked;
        });
        await gate.during(
          awaitGateBeforeSettlement(
            gate.entered,
            pending,
            `${method}: ${change} did not reach discovery`,
          ),
          () => {
            revoked = true;
            const changes: Partial<Record<typeof change, () => void>> = {
              member: () => removeSessionMember(scope, "alice"),
              dirty: invalidateMembership,
              "callback-dirty": () => {
                dirtyOnCheck = true;
              },
              profile: () => {
                client.authenticatedUserProfile!.profileId = "bob";
              },
              projection: () => {
                bindSessionRowProjection(context, () => undefined);
              },
              route: () => setConfig({ ...cfg, session: { mainKey: "replacement" } }),
              policy: () =>
                setConfig({
                  ...cfg,
                  gateway: {
                    roles: {
                      default: "blocked",
                      definitions: {
                        blocked: {
                          sessions: { others: "none" },
                          agents: "*",
                          scopes: ["operator.read", "operator.write"],
                        },
                      },
                    },
                  },
                }),
              session: () => {
                replaceSessionEntrySync(scope, {
                  ...sessionEntry,
                  sessionId: "replacement",
                  updatedAt: 2,
                });
              },
            };
            changes[change]?.();
          },
          pending,
        );
        expect(await pending, change).toMatchObject([false, undefined, expect.any(Object)]);
      }
    });
  },
);

it("uses captured display selections and observes a committed change on the next discovery", async () => {
  await withDiscoveryState(async ({ context }) => {
    const select = (revision: string) =>
      upsertSessionEntryCore(scope, {
        skillLibrarySelections: [
          { skillId: "selected", revision, name: "Selected", ownerProfileId: "owner" },
        ],
      });
    await select("first");
    using gate = createRequestGate();
    const responses: Parameters<RespondFn>[] = [];
    const discoverSelections = () =>
      withSessionDiscoveryAccess(
        {
          client: participant(),
          context,
          sessionKey,
          agentId: "main",
          changedError: errorShape(ErrorCodes.UNAVAILABLE, "Session changed during discovery"),
          respond: (...response) => responses.push(response),
        },
        async (entry) => {
          await gate.pause();
          return entry?.skillLibrarySelections?.map(({ revision }) => revision);
        },
      );
    const pending = discoverSelections();
    await gate.during(
      awaitGateBeforeSettlement(gate.entered, pending, "selection discovery did not start"),
      async () => {
        await select("second");
      },
      pending,
    );
    await discoverSelections();
    expect(responses).toEqual([
      [true, ["first"], undefined],
      [true, ["second"], undefined],
    ]);
  });
});

it.each(["ready", "rejected", "replaced"] as const)(
  "keeps the original target across membership preparation (%s)",
  async (outcome) => {
    await withDiscoveryState(async ({ call, projection }) => {
      using gate = createRequestGate();
      const prepare = projection.prepareMembership.bind(projection);
      vi.spyOn(projection, "prepareMembership").mockImplementationOnce(async () => {
        await gate.pause();
        if (outcome === "rejected") {
          throw new Error("membership unavailable");
        }
        await prepare();
      });
      sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: "category" });
      discovery.mockClear();
      const pending = call("commands.list");
      await gate.during(
        awaitGateBeforeSettlement(
          gate.entered,
          pending,
          "discovery skipped membership preparation",
        ),
        () => {
          expect(discovery).not.toHaveBeenCalled();
          if (outcome === "replaced") {
            replaceSessionEntrySync(scope, {
              sessionId: "replacement",
              updatedAt: 2,
              visibility: "shared",
            });
          }
        },
        pending,
      );
      expect((await pending)[0]).toBe(outcome === "ready");
      if (outcome !== "ready") {
        expect(discovery).not.toHaveBeenCalled();
      }
    });
  },
);
