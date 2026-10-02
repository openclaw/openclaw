import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  withGatewayToolCallerIdentity,
  withGatewayPersonalToolUser,
} from "../../agents/tools/gateway-caller-context.js";
import { createPersonalInstructionsTool } from "../../agents/tools/personal-instructions-tool.js";
import { loadPersonalUserBootstrapFile } from "../../agents/workspace-personal-bootstrap.js";
import { withPersonalToolTurn } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { PreparedUserProfileIdentity } from "../../state/user-profiles.types.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import type { GatewayClient } from "./client-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { usersPersonalFileHandlers } from "./users-personal-file.js";

const state = vi.hoisted(() => ({
  canonical: "alice",
  multipleProfiles: true,
  role: "reader",
  remote: false,
  beforeMutation: undefined as (() => void) | undefined,
  commitGuard: undefined as (() => void) | undefined,
  profileReady: undefined as (() => Promise<void>) | undefined,
  profileHolds: 0,
  rootCalls: 0,
  beforeRoot: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../state/user-profile-list.js", () => ({
  hasMultipleSessionSharingIdentities: () => state.multipleProfiles,
  readResidentUserProfileId: (id: string) => (id === "alice-alias" ? state.canonical : id),
  readUserProfileIdentity: (id: string) => ({ profileId: id, role: state.role }),
  prepareUserProfileIdentity: async (profileId: string): Promise<PreparedUserProfileIdentity> => {
    state.profileHolds += 1;
    let active = true;
    const readCurrentProfile = () => {
      if (!active) {
        throw new Error("Profile preparation was released");
      }
      return { profileId, assignedRole: state.role };
    };
    await state.profileReady?.();
    return {
      readCurrentProfile,
      emailBindingIds: [],
      readCurrentFacts: () => ({
        profile: { ...readCurrentProfile(), emails: [] },
        aliases: new Set([profileId]),
      }),
      release: () => {
        if (active) {
          active = false;
          state.profileHolds -= 1;
        }
      },
    };
  },
}));
vi.mock("../../agents/workspace-access.js", () => ({
  getAgentWorkspaceAccess: () => (state.remote ? {} : undefined),
}));
vi.mock("../../infra/fs-safe.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../infra/fs-safe.js")>();
  return {
    ...original,
    root: async (...args: Parameters<typeof original.root>) => {
      state.rootCalls += 1;
      await state.beforeRoot?.();
      const [dir, defaults] = args;
      return original.root(dir, {
        ...defaults,
        assertBeforeMutation: () => {
          state.beforeMutation?.();
          defaults?.assertBeforeMutation?.();
        },
      });
    },
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
let workspace: string;
let client: GatewayClient;
let connected: boolean;
let config: OpenClawConfig;
let controller: AbortController;

beforeEach(async () => {
  workspace = await fs.realpath(dirs.make("personal-file-"));
  state.canonical = "alice";
  state.multipleProfiles = true;
  state.role = "reader";
  state.remote = false;
  state.beforeMutation = undefined;
  state.commitGuard = undefined;
  state.profileReady = undefined;
  state.profileHolds = 0;
  state.rootCalls = 0;
  state.beforeRoot = undefined;
  connected = true;
  controller = new AbortController();
  config = { agents: { defaults: { workspace } } };
  client = {
    connId: "alice-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId: "alice-alias",
      displayName: null,
      hasAvatar: false,
      updatedAt: 0,
    },
  };
  await fs.writeFile(path.join(workspace, "USER.md"), "Shared defaults");
});

async function rpc(method: "get" | "set", params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  const name = `users.personalFile.${method}`;
  await usersPersonalFileHandlers[name]!({
    req: { type: "req", id: "1", method: name },
    params: { agentId: "main", ...params },
    client,
    respond,
    signal: controller.signal,
    sessionMutationCommitGuard: state.commitGuard,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => config,
      getClientConnIds: (predicate: (candidate: GatewayClient) => boolean) =>
        new Set(connected && predicate(client) ? [client.connId] : []),
    } as unknown as GatewayRequestHandlerOptions["context"],
  });
  expect(respond).toHaveBeenCalledTimes(1);
  const [ok, result, error] = respond.mock.calls[0]!;
  return { ok, result, error };
}
const save = (content: string, expectedHash: string | null = null) =>
  rpc("set", { content, expectedHash });
const personalPath = () => path.join(workspace, "users", "alice", "USER.md");

describe("personal USER.md self-service", () => {
  function toolTurn() {
    const sessionKey = "agent:main:dashboard:someone-elses-project";
    let active = true;
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "alice-alias",
      scopes: ["operator.read"],
      assertCurrent: () => {
        if (!active) {
          throw new Error("requester revoked");
        }
      },
    });
    client = {
      ...client,
      connId: undefined,
      authenticatedUserProfile: { ...client.authenticatedUserProfile!, profileId: "bob" },
      internal: { syntheticClient: true, operatorRunAuthority: authority },
    };
    const context = {
      getRuntimeConfig: () => config,
      trackExecution: trackAsyncWork,
      logGateway: { error: vi.fn(), warn: vi.fn() },
      getGatewayMethodRegistry: () =>
        createGatewayMethodRegistry(
          Object.entries(usersPersonalFileHandlers).map(([name, handler]) => ({
            name,
            handler,
            scope: "operator.read" as const,
            owner: { kind: "core" as const, area: "users" },
          })),
        ),
    } as unknown as GatewayRequestHandlerOptions["context"];
    const identity = {
      agentId: "main",
      sessionKey,
      operationalRunInstance: { instanceId: sessionKey, runId: "personal-test-run" },
      operatorAuthority: authority,
      receiptAuthority: () => active,
      gatewayContextResolver: () => context,
    };
    return {
      identity,
      revoke: () => {
        active = false;
      },
    };
  }

  it("routes the read-only requester's chat tool from a foreign session to their canonical file", async () => {
    const { identity } = toolTurn();
    const tool = createPersonalInstructionsTool("main");
    const execute = (params: Record<string, unknown>) =>
      withGatewayToolCallerIdentity(identity, () =>
        tool.execute("personal-call", params, controller.signal),
      );
    expect((await execute({ action: "get" })).details).toMatchObject({
      profileId: "alice",
      missing: true,
      hash: null,
    });
    expect(
      (await execute({ action: "set", content: "Prefer examples.", expectedHash: null })).details,
    ).toMatchObject({ profileId: "alice", content: "Prefer examples." });
    expect(await fs.readFile(personalPath(), "utf8")).toBe("Prefer examples.");
    expect(await fs.readdir(path.join(workspace, "users"))).toEqual(["alice"]);
    expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe("Shared defaults");
  });

  function withRequesterTurn(test: Parameters<typeof withPersonalToolTurn>[1]) {
    const { identity } = toolTurn();
    return withPersonalToolTurn(
      { owner: { profileId: "alice-alias", senderId: "alice", name: "Alice" } },
      (turn) =>
        withGatewayToolCallerIdentity(
          { ...identity, operationalRunInstance: undefined, operatorAuthority: undefined },
          () => test(turn),
        ),
    );
  }

  it.each(["get", "set"] as const)(
    "rejects personal %s after an accepted cross-profile steer before touching USER.md",
    async (action) => {
      await withRequesterTurn(async (turn) => {
        const tool = createPersonalInstructionsTool("main");
        const execute = (params: Record<string, unknown>) => tool.execute("personal-call", params);
        const saved = await execute({
          action: "set",
          content: "Alice's preferences",
          expectedHash: null,
        });
        expect(saved.details).toMatchObject({
          profileId: "alice",
          content: "Alice's preferences",
        });
        const before = state.rootCalls;
        expect(await turn.steer({ profileId: "bob", senderId: "bob", name: "Bob" })).toMatchObject({
          status: "accepted",
        });
        await expect(
          withGatewayPersonalToolUser("alice-alias", () =>
            execute({
              action,
              ...(action === "set"
                ? {
                    content: "Bob's preferences",
                    expectedHash: (saved.details as { hash: string }).hash,
                  }
                : {}),
            }),
          ),
        ).rejects.toThrow(/own.*(turn|Control UI)/);
        expect(state.rootCalls).toBe(before);
        expect(await fs.readFile(personalPath(), "utf8")).toBe("Alice's preferences");
      });
    },
  );

  it.each(["get", "set"] as const)(
    "rechecks participant ambiguity after filesystem preparation for personal %s",
    async (action) => {
      await withRequesterTurn(async (turn) => {
        state.beforeRoot = async () => {
          expect(
            await turn.steer({ profileId: "bob", senderId: "bob", name: "Bob" }),
          ).toMatchObject({ status: "accepted" });
        };
        await expect(
          createPersonalInstructionsTool("main").execute("personal-call", {
            action,
            ...(action === "set" ? { content: "Ambiguous", expectedHash: null } : {}),
          }),
        ).rejects.toThrow(/own.*(turn|Control UI)/);
        expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
      });
    },
  );

  it.each([
    { kind: "shared-secret", boundary: "live" },
    { kind: "device-token", boundary: "live" },
    { kind: "shared-secret", boundary: "attestation removed" },
    { kind: "shared-secret", boundary: "connection aborted" },
    { kind: "shared-secret", boundary: "connection replaced" },
  ] as const)(
    "carries authenticated $kind owner ingress through the chat tool: $boundary",
    async ({ kind, boundary }) => {
      const { identity } = toolTurn();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const connection = new AbortController();
      if (boundary !== "live") {
        state.profileReady = async () => {
          entered.resolve();
          await resume.promise;
        };
      }
      const ingress: GatewayClient = {
        ...client,
        connId: "local-owner-connection",
        connectionSignal: connection.signal,
        connect: { ...client.connect, scopes: ["operator.write"] },
        authenticatedUserProfile: {
          ...client.authenticatedUserProfile!,
          profileId: GATEWAY_OWNER_PROFILE_ID,
        },
        internal: {
          authenticatedOperator: true,
          ...(kind === "shared-secret" ? { operatorRoleActor: { kind: "system" as const } } : {}),
        },
      };
      const preparation = captureGatewayOperatorRunAuthority({
        client: ingress,
        context: identity.gatewayContextResolver(),
        hasCurrentClientAuthority: () => true,
      });
      const pending = (async () => {
        const captured = await preparation;
        expect(captured).toBeDefined();
        if (!captured) {
          throw new Error("authenticated owner source missing");
        }
        try {
          const tool = createPersonalInstructionsTool("main");
          const call = (params: Record<string, unknown>) =>
            withGatewayToolCallerIdentity(
              { ...identity, operatorAuthority: captured.authority },
              () => tool.execute("owner-call", params, controller.signal),
            );
          expect((await call({ action: "get" })).details).toMatchObject({
            profileId: GATEWAY_OWNER_PROFILE_ID,
            missing: true,
          });
          await call({ action: "set", content: "Owner preferences", expectedHash: null });
          expect(
            await fs.readFile(
              path.join(workspace, "users", GATEWAY_OWNER_PROFILE_ID, "USER.md"),
              "utf8",
            ),
          ).toBe("Owner preferences");
          expect(await fs.readdir(path.join(workspace, "users"))).toEqual([
            GATEWAY_OWNER_PROFILE_ID,
          ]);
          captured.release();
          await expect(call({ action: "get" })).rejects.toThrow("no longer active");
        } finally {
          captured.release();
        }
      })();
      const checked =
        boundary === "live"
          ? expect(pending).resolves.toBeUndefined()
          : expect(pending).rejects.toThrow(/authority|connection/);
      try {
        if (boundary !== "live") {
          await Promise.race([entered.promise, pending]);
          if (boundary === "attestation removed") {
            delete ingress.internal!.authenticatedOperator;
          } else if (boundary === "connection replaced") {
            ingress.connId = "replacement-owner-connection";
            ingress.connectionSignal = new AbortController().signal;
          } else {
            connection.abort(new Error("owner connection ended"));
          }
          resume.resolve();
        }
        await checked;
        if (boundary !== "live") {
          expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
          expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe(
            "Shared defaults",
          );
        }
        expect(state.profileHolds).toBe(0);
      } finally {
        resume.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );

  it.each(["unattested", "synthetic", "agent-tool", "unprofiled", "node", "invalidated"])(
    "does not create owner authority for %s work",
    async (kind) => {
      const { identity } = toolTurn();
      const ingress: GatewayClient = {
        ...client,
        connId: "owner-source",
        authenticatedUserProfile: {
          ...client.authenticatedUserProfile!,
          profileId: GATEWAY_OWNER_PROFILE_ID,
        },
        internal: { authenticatedOperator: true, operatorRoleActor: { kind: "system" } },
      };
      if (kind === "unattested") {
        delete ingress.internal!.authenticatedOperator;
      }
      if (kind === "synthetic") {
        ingress.internal!.syntheticClient = true;
      }
      if (kind === "agent-tool") {
        ingress.internal!.agentToolCaller = { agentId: "main", sessionKey: "agent:main:main" };
      }
      if (kind === "unprofiled") {
        delete ingress.authenticatedUserProfile;
      }
      if (kind === "node") {
        ingress.connect = { ...ingress.connect, role: "node" };
      }
      if (kind === "invalidated") {
        ingress.invalidated = true;
      }
      expect(
        await captureGatewayOperatorRunAuthority({
          client: ingress,
          context: identity.gatewayContextResolver(),
        }),
      ).toBeUndefined();
    },
  );

  it("rejects a different source even when its profile matches", async () => {
    const { identity } = toolTurn();
    client.internal!.operatorRunAuthority = createAdmittedRunOperatorAuthority({
      profileId: identity.operatorAuthority.profileId,
      scopes: ["operator.read"],
      assertCurrent: () => {},
    });
    expect((await withGatewayToolCallerIdentity(identity, () => save("Different source"))).ok).toBe(
      false,
    );
  });

  it("rejects copied requester authority without its live admitted tool run", async () => {
    toolTurn();
    expect((await save("Unadmitted")).ok).toBe(false);
    const { identity } = toolTurn();
    expect(
      (
        await withGatewayToolCallerIdentity({ ...identity, operatorAuthority: undefined }, () =>
          save("Wrong source"),
        )
      ).ok,
    ).toBe(false);
    expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
  });

  it.each(["source", "run", "commit"])(
    "rechecks delegated %s authority before filesystem mutation",
    async (boundary) => {
      const turn = toolTurn();
      if (boundary === "commit") {
        let current = true;
        state.commitGuard = () => {
          if (!current) {
            throw new Error("dispatch revoked");
          }
        };
        state.beforeMutation = () => {
          current = false;
        };
      } else if (boundary === "source") {
        state.beforeMutation = turn.revoke;
      } else {
        let current = true;
        turn.identity.receiptAuthority = () => current;
        state.beforeMutation = () => {
          current = false;
        };
      }
      expect((await withGatewayToolCallerIdentity(turn.identity, () => save("Retired"))).ok).toBe(
        false,
      );
      await expect(fs.readFile(personalPath(), "utf8")).rejects.toThrow();
    },
  );

  it("never falls back to the Gateway owner when chat has no authenticated requester", async () => {
    await expect(
      createPersonalInstructionsTool("main").execute("anonymous", { action: "get" }),
    ).rejects.toThrow("authenticated Gateway user turn");
  });

  it("rejects personal reads and writes on a single-user Gateway without touching files", async () => {
    state.multipleProfiles = false;
    expect(await rpc("get")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await save("Not a second USER.md")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
    expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe("Shared defaults");
  });

  it("lets a read-only signed-in user create, read, and edit only their canonical file", async () => {
    expect(await rpc("get")).toMatchObject({
      ok: true,
      result: { missing: true, hash: null, content: "", profileId: "alice" },
    });
    const created = await save("Prefer concise replies.");
    expect(created).toMatchObject({ ok: true, result: { profileId: "alice", missing: false } });
    expect(await fs.readFile(personalPath(), "utf8")).toBe("Prefer concise replies.");
    expect(await rpc("get")).toMatchObject({ ok: true, result: created.result });
    expect(await save("Prefer examples.", created.result.hash)).toMatchObject({ ok: true });
    expect(await fs.readFile(personalPath(), "utf8")).toBe("Prefer examples.");
    expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe("Shared defaults");
    expect(await fs.readdir(path.join(workspace, "users"))).toEqual(["alice"]);
    expect(await loadPersonalUserBootstrapFile(workspace, "alice")).toMatchObject({
      personalUser: true,
      content: "Prefer examples.",
      path: personalPath(),
    });
  });

  it("requires a hash for every save and detects concurrent creation and stale edits", async () => {
    expect(await rpc("set", { content: "unsafe" })).toMatchObject({ ok: false });
    const attempts = await Promise.all([save("First"), save("Second")]);
    expect(attempts.map((attempt) => attempt.ok)).toEqual(expect.arrayContaining([false, true]));
    const created = attempts.find((x) => x.ok)!;
    const updated = await save("Updated", created.result.hash);
    expect(updated.ok).toBe(true);
    expect(await save("Stale", created.result.hash)).toMatchObject({
      ok: false,
      error: { details: { type: "personal_file_conflict" } },
    });
    expect(await fs.readFile(personalPath(), "utf8")).toBe("Updated");
    expect(await save("", updated.result.hash)).toMatchObject({
      ok: true,
      result: { content: "", missing: false },
    });
  });

  it("rejects a caller-selected profile even for administrators", async () => {
    client.connect.scopes = ["operator.admin"];
    for (const method of ["get", "set"] as const) {
      expect(
        await rpc(method, {
          ...(method === "set" ? { content: "Bad", expectedHash: null } : {}),
          profileId: "bob",
        }),
      ).toMatchObject({ ok: false });
    }
    expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
  });

  it.each(["anonymous", "synthetic", "node"])("rejects %s callers", async (kind) => {
    if (kind === "anonymous") {
      client.authenticatedUserProfile = undefined;
    }
    if (kind === "synthetic") {
      client.internal = { syntheticClient: true };
    }
    if (kind === "node") {
      client.connect.role = "node";
    }
    expect(await save("Bad")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
  });

  it.each([
    "single-user",
    "profile-merge",
    "disconnect",
    "scope-revocation",
    "transport-revocation",
    "role-revocation",
    "workspace-change",
    "cancellation",
  ])("rechecks %s inside the safe writer before mutation", async (kind) => {
    config.gateway = {
      roles: {
        definitions: {
          reader: { scopes: ["operator.read"], agents: ["main"], sessions: { others: "none" } },
          denied: { scopes: [], agents: [], sessions: { others: "none" } },
        },
      },
    };
    state.beforeMutation = () => {
      if (kind === "single-user") {
        state.multipleProfiles = false;
      }
      if (kind === "role-revocation") {
        state.role = "denied";
      }
      if (kind === "profile-merge") {
        state.canonical = "bob";
      }
      if (kind === "disconnect") {
        connected = false;
      }
      if (kind === "transport-revocation") {
        client.invalidated = true;
      }
      if (kind === "scope-revocation") {
        client.connect.scopes = [];
      }
      if (kind === "workspace-change") {
        config = { agents: { defaults: { workspace: workspace + "-moved" } } };
      }
      if (kind === "cancellation") {
        controller.abort();
      }
    };
    expect((await save("Bad")).ok).toBe(false);
    expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
  });

  it.each(["parent-symlink", "file-symlink", "hardlink"])(
    "rejects %s aliases for reads and writes",
    async (kind) => {
      await fs.mkdir(path.join(workspace, "users", "bob"), { recursive: true });
      const other = path.join(workspace, "users", "bob", "USER.md");
      await fs.writeFile(other, "Bob's instructions");
      if (kind === "parent-symlink") {
        await fs.symlink("bob", path.join(workspace, "users", "alice"), "dir");
      } else {
        await fs.mkdir(path.dirname(personalPath()));
        if (kind === "file-symlink") {
          await fs.symlink(other, personalPath());
        } else {
          await fs.link(other, personalPath());
        }
      }
      expect((await rpc("get")).ok).toBe(false);
      expect((await save("Bad")).ok).toBe(false);
      expect(await fs.readFile(other, "utf8")).toBe("Bob's instructions");
    },
  );

  it("rejects invalid agent IDs, remote workspaces, and content outside the bootstrap cap", async () => {
    expect((await rpc("get", { agentId: "../main" })).ok).toBe(false);
    expect((await rpc("get", { agentId: "unknown" })).ok).toBe(false);
    expect((await save("a".repeat(4001))).ok).toBe(false);
    expect((await save("😀".repeat(2001))).ok).toBe(false);
    state.remote = true;
    expect((await save("Bad")).ok).toBe(false);
    expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
  });
});
