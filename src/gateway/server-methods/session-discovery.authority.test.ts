import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import * as sharingPreparation from "../session-sharing-preparation.js";
import { commandsHandlers } from "./commands.js";
import { handleSkillsStatus } from "./skills-status.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const { discovery } = vi.hoisted(() => ({ discovery: vi.fn(async () => {}) }));
// Library storage, workspace discovery, and exec-policy storage have separate owners.
vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
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
const handlers = {
  "commands.list": commandsHandlers["commands.list"]!,
  "skills.status": handleSkillsStatus,
};

function participant(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: {
      profileId: "alice",
      displayName: "Alice",
      hasAvatar: false,
      updatedAt: 1,
    },
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
  await upsertSessionEntryCore(scope, {
    sessionId: "discovery",
    updatedAt: 1,
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "owner" },
  });
  addSessionMember(scope, { identityId: "alice", addedBy: "owner" });
}

it.each(["commands.list", "skills.status"] as const)(
  "%s discovers for a participant without caller-thread SQL",
  async (method) => {
    await withDiscoveryState(async ({ call }) => {
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      try {
        expect((await call(method))[0]).toBe(true);
        console.log(
          `${method}: caller SQL prepare=${prepare.mock.calls.length} exec=${exec.mock.calls.length}`,
        );
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
  "%s refuses authority or selections revoked during discovery",
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
        "selection",
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
        const entered = createDeferredCore();
        const release = createDeferredCore();
        discovery.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
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
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            `${method}: ${change} did not reach discovery`,
          );
          revoked = true;
          if (change === "member") {
            removeSessionMember(scope, "alice");
          }
          if (change === "dirty") {
            invalidateMembership();
          }
          if (change === "callback-dirty") {
            dirtyOnCheck = true;
          }
          if (change === "profile") {
            client.authenticatedUserProfile!.profileId = "bob";
          }
          if (change === "projection") {
            bindSessionRowProjection(context, () => undefined);
          }
          if (change === "route") {
            setConfig({ ...cfg, session: { mainKey: "replacement" } });
          }
          if (change === "policy") {
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
            });
          }
          if (change === "session" || change === "selection") {
            replaceSessionEntrySync(scope, {
              sessionId: change === "session" ? "replacement" : "discovery",
              updatedAt: 2,
              visibility: "read-only",
              createdActor: { type: "human", source: "profile", id: "owner" },
              ...(change === "selection"
                ? {
                    skillLibrarySelections: [
                      {
                        skillId: "selected",
                        revision: "second",
                        name: "Selected",
                        ownerProfileId: "owner",
                      },
                    ],
                  }
                : {}),
            });
          }
        } finally {
          release.resolve();
        }
        expect(await pending, change).toMatchObject([false, undefined, expect.any(Object)]);
      }
    });
  },
);

it.each(["ready", "rejected", "replaced"] as const)(
  "keeps the original target across membership preparation (%s)",
  async (outcome) => {
    await withDiscoveryState(async ({ call, projection }) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepare = projection.prepareMembership.bind(projection);
      vi.spyOn(projection, "prepareMembership").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        if (outcome === "rejected") {
          throw new Error("membership unavailable");
        }
        await prepare();
      });
      sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: "category" });
      discovery.mockClear();
      const pending = call("commands.list");
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "discovery skipped membership preparation",
        );
        expect(discovery).not.toHaveBeenCalled();
        if (outcome === "replaced") {
          replaceSessionEntrySync(scope, {
            sessionId: "replacement",
            updatedAt: 2,
            visibility: "shared",
          });
        }
      } finally {
        release.resolve();
      }
      expect((await pending)[0]).toBe(outcome === "ready");
      if (outcome !== "ready") {
        expect(discovery).not.toHaveBeenCalled();
      }
    });
  },
);

it("uses the retained physical source when dirty topology needs fallback preparation", async () => {
  await withDiscoveryState(async ({ call }) => {
    sessionChanges.emit({ all: true, scope: "stores" });
    const prepare = vi.spyOn(sharingPreparation, "prepareSessionMutationFacts");
    expect((await call("commands.list"))[0]).toBe(true);
    expect(prepare).toHaveBeenCalled();
  });
});
