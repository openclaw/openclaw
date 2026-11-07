import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { captureRequesterOrigin } from "../../agents/requester-origin.js";
import {
  withGatewayToolCallerIdentity,
  withGatewayPersonalToolUser,
} from "../../agents/tools/gateway-caller-context.js";
import { createPersonalInstructionsTool } from "../../agents/tools/personal-instructions-tool.js";
import { loadPersonalUserBootstrapFile } from "../../agents/workspace-personal-bootstrap.js";
import { withPersonalToolTurn } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  PreparedUserProfileIdentity,
  UserProfileDisplay,
  UserProfileIdentity,
} from "../../state/user-profiles.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
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
  beforeWrite: undefined as (() => Promise<void>) | undefined,
}));
// mock-isolation: exercise profile revocation without opening shared profile storage.
vi.mock("../../state/user-profile-list.js", () => ({
  isUserProfileCatalogReady: () => true,
  prepareUserProfileCatalog: async () => ({
    hasMultipleSessionSharingIdentities: () => state.multipleProfiles,
    readCurrentIdentity: (id: string) => ({
      profileId: id === "alice-alias" ? state.canonical : id,
      role: state.role,
    }),
    readCurrentAuthority: (id: string) => ({
      profileId: id === "alice-alias" ? state.canonical : id,
      role: state.role,
      aliases: [id],
      display: {
        id: id === "alice-alias" ? state.canonical : id,
        displayName: null,
        hasAvatar: false,
        avatarRevision: "0",
      },
    }),
    release: () => {},
  }),
  hasMultipleSessionSharingIdentities: () => state.multipleProfiles,
  hasMultipleResidentSessionSharingIdentities: () => state.multipleProfiles,
  readUserProfileIdentity: (id: string): UserProfileIdentity => ({
    profileId: id === "alice-alias" ? state.canonical : id,
    role: state.role,
    aliases: new Set([id]),
  }),
  readResidentUserProfileId: (id: string) => (id === "alice-alias" ? state.canonical : id),
  readResidentUserProfileIdentity: (id: string) => ({ profileId: id, role: state.role }),
  getUserProfileDisplay: (id: string): UserProfileDisplay => ({
    id,
    displayName: null,
    hasAvatar: false,
    avatarRevision: "0",
  }),
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
      readCurrentRevision: readCurrentProfile,
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
      const handle = await original.root(dir, {
        ...defaults,
        assertBeforeMutation: () => {
          state.beforeMutation?.();
          defaults?.assertBeforeMutation?.();
        },
      });
      const write = handle.write.bind(handle);
      handle.write = async (...params) => {
        await state.beforeWrite?.();
        return write(...params);
      };
      return handle;
    },
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
let testState: OpenClawTestState;
let workspace: string;
let client: GatewayClient;
let connected: boolean;
let config: OpenClawConfig;
let controller: AbortController;

beforeEach(async () => {
  testState = await createOpenClawTestState({ layout: "state-only" });
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
  state.beforeWrite = undefined;
  connected = true;
  controller = new AbortController();
  config = {
    agents: { defaults: { workspace } },
    session: { store: testState.statePath("sessions.sqlite") },
  };
  client = {
    connId: "alice-connection",
    connect: gatewayConnect(["operator.read"]),
    authenticatedUserProfile: gatewayProfile("alice-alias", null, 0),
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

afterEach(async () => {
  await testState.cleanup();
});

async function toolSession(sessionKey: string, changes: Partial<InternalSessionEntry> = {}) {
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath: testState.statePath("sessions.sqlite") },
    {
      sessionId: "personal-tool",
      updatedAt: 1,
      visibility: "draft",
      createdActor: { type: "human", source: "profile", id: "alice" },
      ...changes,
    },
  );
}

describe("personal USER.md self-service", () => {
  async function toolTurn(scopes = ["operator.read"], creator = "alice") {
    client.connect.scopes = scopes;
    const sessionKey = "agent:main:dashboard:personal-" + creator;
    await toolSession(sessionKey, {
      createdActor: { type: "human", source: "profile", id: creator },
    });
    let active = true;
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "alice-alias",
      scopes,
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

  it.each(["operator.read", "operator.sessions.read"])(
    "routes the %s requester's chat tool to their canonical file, not the synthetic client profile",
    async (scope) => {
      const { identity } = await toolTurn([scope]);
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
      expect((await execute({ action: "get" })).details).toMatchObject({
        profileId: "alice",
        missing: false,
        content: "Prefer examples.",
      });
      expect(await fs.readFile(personalPath(), "utf8")).toBe("Prefer examples.");
      expect(await fs.readdir(path.join(workspace, "users"))).toEqual(["alice"]);
      expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe("Shared defaults");
      expect(await loadPersonalUserBootstrapFile(workspace, "alice")).toMatchObject({
        personalUser: true,
        content: "Prefer examples.",
        path: personalPath(),
      });
    },
  );

  it.each(["get", "set"] as const)(
    "keeps personal %s out of group and channel tool results without touching either file",
    async (action) => {
      const { identity } = await toolTurn(["operator.sessions.read"]);
      const tool = createPersonalInstructionsTool("main");
      const original = "Alice private instructions";
      const peer = path.join(workspace, "users", "bob", "USER.md");
      await fs.mkdir(path.dirname(personalPath()), { recursive: true });
      await fs.mkdir(path.dirname(peer), { recursive: true });
      await fs.writeFile(personalPath(), original);
      await fs.writeFile(peer, "Bob private instructions");
      const before = await withGatewayToolCallerIdentity(identity, () =>
        tool.execute("personal-read", { action: "get" }),
      );
      const hash = (before.details as { hash: string }).hash;
      const groupKey = "agent:main:discord:group:room";
      const channelKey = "agent:main:discord:channel:room";
      for (const [sessionKey, sourceKey, chatType] of [
        [identity.sessionKey, "agent:main:opaque", "group"],
        [identity.sessionKey, "agent:main:opaque", "channel"],
        [identity.sessionKey, groupKey, undefined],
        [identity.sessionKey, channelKey, undefined],
        [groupKey, undefined, undefined],
        [channelKey, undefined, undefined],
        [groupKey, "agent:main:private-source", "direct"],
      ] as const) {
        const beforeRoots = state.rootCalls;
        const caller = {
          ...identity,
          sessionKey,
          requesterOrigin: sourceKey
            ? captureRequesterOrigin({ sessionKey: sourceKey, chatType })
            : undefined,
        };
        await expect(
          withGatewayToolCallerIdentity(caller, () =>
            tool.execute("personal-shared", {
              action,
              ...(action === "set" ? { content: "Must not save", expectedHash: hash } : {}),
            }),
          ),
        ).rejects.toThrow(/Settings.*Profile.*Personal instructions/);
        expect(state.rootCalls).toBe(beforeRoots);
        expect(await fs.readFile(personalPath(), "utf8")).toBe(original);
        expect(await fs.readFile(peer, "utf8")).toBe("Bob private instructions");
        expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe("Shared defaults");
      }
      // A host-resolved direct label also needs creator-private session facts.
      await toolSession(groupKey);
      const direct = await withGatewayToolCallerIdentity(
        {
          ...identity,
          sessionKey: groupKey,
          requesterOrigin: captureRequesterOrigin({
            sessionKey: groupKey,
            chatType: "direct",
          }),
        },
        () => tool.execute("personal-direct", { action: "get" }),
      );
      expect(direct.details).toMatchObject({ profileId: "alice", content: original });
    },
  );

  it.each(["get", "set"] as const)(
    "withholds personal %s from non-private web audiences",
    async (action) => {
      const { identity } = await toolTurn();
      const tool = createPersonalInstructionsTool("main");
      const call = () =>
        withGatewayToolCallerIdentity(identity, () =>
          tool.execute("web-audience", {
            action,
            ...(action === "set" ? { content: "Must not save", expectedHash: null } : {}),
          }),
        );
      for (const changes of [
        { visibility: "shared" },
        { visibility: "read-only" },
        { visibility: "suggest" },
        { publicShare: { id: "c".repeat(48), sessionId: "personal-tool", createdAt: 1 } },
      ] satisfies Partial<InternalSessionEntry>[]) {
        await toolSession(identity.sessionKey, changes);
        const roots = state.rootCalls;
        await expect(call()).rejects.toThrow(/Settings.*Profile.*Personal instructions/);
        expect(state.rootCalls).toBe(roots);
        expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
      }
      // A private execution target does not hide a shared origin's transcript audience.
      await toolSession(identity.sessionKey, { publicShare: undefined });
      const originKey = "agent:main:dashboard:shared-source";
      await toolSession(originKey, { visibility: "shared" });
      await expect(
        withGatewayToolCallerIdentity(
          {
            ...identity,
            requesterOrigin: captureRequesterOrigin({ sessionKey: originKey, chatType: "direct" }),
          },
          () =>
            tool.execute("delegated-web", {
              action,
              ...(action === "set" ? { content: "Must not save", expectedHash: null } : {}),
            }),
        ),
      ).rejects.toThrow(/Settings.*Profile.*Personal instructions/);
    },
  );

  it.each(["get", "set"] as const)(
    "rechecks web audience before personal %s release or mutation",
    async (action) => {
      const { identity } = await toolTurn();
      const change = () => toolSession(identity.sessionKey, { visibility: "shared" });
      if (action === "get") {
        state.beforeRoot = change;
      } else {
        state.beforeWrite = change;
      }
      const tool = createPersonalInstructionsTool("main");
      await expect(
        withGatewayToolCallerIdentity(identity, () =>
          tool.execute("audience-change", {
            action,
            ...(action === "set" ? { content: "Must not save", expectedHash: null } : {}),
          }),
        ),
      ).rejects.toThrow();
      expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
    },
  );

  it("does not disclose an authenticated editor's file into another person's private draft", async () => {
    const { identity } = await toolTurn(["operator.read"], "bob");
    await expect(
      withGatewayToolCallerIdentity(identity, () =>
        createPersonalInstructionsTool("main").execute("foreign-draft", { action: "get" }),
      ),
    ).rejects.toThrow(/Settings.*Profile.*Personal instructions/);
    expect(state.rootCalls).toBe(0);
  });

  async function withRequesterTurn(test: Parameters<typeof withPersonalToolTurn>[1]) {
    const { identity } = await toolTurn();
    return withPersonalToolTurn(
      {
        owner: { profileId: "alice-alias", senderId: "alice", name: "Alice" },
        sessionKey: identity.sessionKey,
        config,
        allowCollaborativeSteering: true,
      },
      (turn) =>
        withGatewayToolCallerIdentity(
          { ...identity, operationalRunInstance: undefined, operatorAuthority: undefined },
          () => test(turn),
        ),
    );
  }

  it.each(
    (["get", "set"] as const).flatMap((action) =>
      (["before", "after preparation"] as const).map((phase) => ({ action, phase })),
    ),
  )("rejects personal $action when another profile steers $phase", async ({ action, phase }) => {
    await withRequesterTurn(async (turn) => {
      const tool = createPersonalInstructionsTool("main");
      const execute = (params: Record<string, unknown>) => tool.execute("personal-call", params);
      const steer = async () => {
        expect(await turn.steer({ profileId: "bob", senderId: "bob", name: "Bob" })).toMatchObject({
          status: "accepted",
        });
      };
      if (phase === "before") {
        const saved = await execute({
          action: "set",
          content: "Alice's preferences",
          expectedHash: null,
        });
        expect(saved.details).toMatchObject({ profileId: "alice", content: "Alice's preferences" });
        const before = state.rootCalls;
        await steer();
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
      } else {
        state.beforeRoot = steer;
        await expect(
          execute({
            action,
            ...(action === "set" ? { content: "Ambiguous", expectedHash: null } : {}),
          }),
        ).rejects.toThrow(/own.*(turn|Control UI)/);
        expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
      }
    });
  });

  it.each([
    { kind: "shared-secret", boundary: "live" },
    { kind: "device-token", boundary: "live" },
    { kind: "shared-secret", boundary: "attestation removed" },
    { kind: "shared-secret", boundary: "connection aborted" },
    { kind: "shared-secret", boundary: "connection replaced" },
  ] as const)(
    "carries authenticated $kind owner ingress through the chat tool: $boundary",
    async ({ kind, boundary }) => {
      const { identity } = await toolTurn(["operator.read"], GATEWAY_OWNER_PROFILE_ID);
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
      const { identity } = await toolTurn();
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

  it.each(["different source", "unadmitted", "missing source"])(
    "rejects copied requester authority with %s",
    async (kind) => {
      const { identity } = await toolTurn();
      if (kind === "different source") {
        client.internal!.operatorRunAuthority = createAdmittedRunOperatorAuthority({
          profileId: identity.operatorAuthority.profileId,
          scopes: ["operator.read"],
          assertCurrent: () => {},
        });
      }
      const result =
        kind === "unadmitted"
          ? await save("Unadmitted")
          : await withGatewayToolCallerIdentity(
              kind === "missing source" ? { ...identity, operatorAuthority: undefined } : identity,
              () => save("Wrong source"),
            );
      expect(result.ok).toBe(false);
      expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
    },
  );

  it.each(["source", "run", "commit"])(
    "rechecks delegated %s authority before filesystem mutation",
    async (boundary) => {
      const turn = await toolTurn();
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

  it.each(["single-user", "selected-profile", "anonymous", "synthetic", "node", "no-scope"])(
    "rejects personal-file requests for %s before touching files",
    async (kind) => {
      if (kind === "single-user") {
        state.multipleProfiles = false;
      }
      if (kind === "selected-profile") {
        client.connect.scopes = ["operator.admin"];
      }
      if (kind === "anonymous") {
        client.authenticatedUserProfile = undefined;
      }
      if (kind === "synthetic") {
        client.internal = { syntheticClient: true };
      }
      if (kind === "node") {
        client.connect.role = "node";
      }
      if (kind === "no-scope") {
        client.connect.scopes = [];
      }
      for (const method of ["get", "set"] as const) {
        expect(
          await rpc(method, {
            ...(method === "set" ? { content: "Bad", expectedHash: null } : {}),
            ...(kind === "selected-profile" ? { profileId: "bob" } : {}),
          }),
        ).toMatchObject({
          ok: false,
          ...(kind === "selected-profile" ? {} : { error: { code: "FORBIDDEN" } }),
        });
      }
      expect(await fs.readdir(workspace)).toEqual(["USER.md"]);
      expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe("Shared defaults");
    },
  );

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
    client.connect.scopes = ["operator.sessions.read"];
    config.gateway = {
      roles: {
        definitions: {
          reader: {
            scopes: ["operator.sessions.read"],
            agents: ["main"],
            sessions: { others: "none" },
          },
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
