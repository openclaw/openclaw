import { afterEach, expect, test, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { withGatewayPersonalToolUser } from "../../agents/tools/gateway-caller-context.js";
import { withPersonalToolTurn } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { holdNextReply } from "../../state/github-publication.worker.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import * as preferences from "../../state/user-preferences.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail, mergeProfiles, setAvatar } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createRequestGate } from "../server-methods.request-gate.test-support.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "../server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { createGatewayWsTestSocket } from "../server/ws-connection.test-helpers.js";
import { createOperatorWsClient } from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayClient } from "./types.js";
import { usersHandlers } from "./users.js";

async function withPreferenceState(
  run: (prepareProfiles: () => Promise<void>) => Promise<void>,
  runtime = false,
) {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-prefs-" });
  let releaseProfiles: (() => void) | undefined;
  try {
    if (runtime) {
      setRuntimeConfigSnapshot({});
    }
    await run(async () => {
      releaseProfiles = (await prepareUserProfileCatalog()).release;
    });
  } finally {
    releaseProfiles?.();
    if (runtime) {
      clearRuntimeConfigSnapshot();
    }
    await state.cleanup();
  }
}

type PreferenceMethod = "users.prefs.get" | "users.prefs.set";
const forbidden = expect.objectContaining({
  code: "FORBIDDEN",
  message: "Gateway requester authority changed",
});
const preferenceReply = (entries: Record<string, unknown>) => [
  true,
  { status: "ok", entries },
  undefined,
];
const getPrefs = (profileId?: string, params = {}, context = {}) =>
  invokePreferenceMethod("users.prefs.get", params, profileId, context);
const setPrefs = (profileId: string | undefined, params: Record<string, unknown>, context = {}) =>
  invokePreferenceMethod("users.prefs.set", params, profileId, context);

function dispatch(
  client: GatewayClient,
  method: string,
  params = {},
  context = createDirectChatContext(),
  hasCurrentClientAuthority?: () => boolean,
) {
  const respond = vi.fn();
  const request = handleGatewayRequest({
    req: { type: "req", id: method, method, params },
    client,
    context,
    respond,
    hasCurrentClientAuthority,
    isWebchatConnect: () => false,
    extraHandlers: usersHandlers,
  });
  return { respond, request };
}
function attachProfile(
  client: GatewayClient,
  profile: { id: string; updatedAt: number },
  hasAvatar = false,
) {
  client.authenticatedUserProfile = {
    profileId: profile.id,
    displayName: null,
    avatarRevision: "",
    hasAvatar,
    updatedAt: profile.updatedAt,
  };
  prepareGatewayRecipientProfile(client);
}

async function invokePreferenceMethod(
  method: PreferenceMethod,
  params: Record<string, unknown>,
  profileId?: string,
  context: Record<string, unknown> = {},
) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await usersHandlers[method]!({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: context as never,
    client: {
      connect: { scopes: ["operator.admin"] },
      ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
    } as never,
    isWebchatConnect: () => false,
  });
  return result;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("users.prefs reads merged-profile accents while an unrelated writer reply is pending", async ({
  signal,
}) => {
  return withPreferenceState(async () => {
    const source = ensureProfileForEmail("source@example.test").id;
    const target = ensureProfileForEmail("target@example.test").id;
    await preferences.setCanonicalUserPreferences(source, {
      "ui.accent": "#a1b2c3",
      other: "excluded",
    });
    mergeProfiles(source, target);
    const context = captureOpenClawStateWorkerContext();
    const recordUnrelatedProvenance = () =>
      executeOpenClawStateWorker(context, {
        type: "agentProvenance.record",
        input: {
          agentId: "preference-reader-test",
          createdVia: "operator",
          creatorAgentId: null,
          createdAtMs: 1,
        },
      });
    await recordUnrelatedProvenance();
    const reply = holdNextReply("agentProvenance.record");
    const pendingWriter = recordUnrelatedProvenance();
    try {
      await withinTest(reply.ready, signal);
      expect(await withinTest(getPrefs(source, { keys: ["ui.accent"] }), signal)).toEqual({
        ok: true,
        payload: { status: "ok", entries: { "ui.accent": "#a1b2c3" } },
        error: undefined,
      });
    } finally {
      reply.release();
      vi.spyOn(Worker.prototype, "postMessage").mockRestore();
      vi.spyOn(Worker.prototype, "emit").mockRestore();
      await pendingWriter;
    }
  });
});

async function withPreferenceToolTurn(
  run: (params: {
    ownerId: string;
    steer: () => Promise<void>;
    revoke: () => void;
    request: (method: PreferenceMethod, params?: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<void>,
) {
  return withPreferenceState(async () => {
    const owner = ensureProfileForEmail("prefs-owner@example.test");
    const guest = ensureProfileForEmail("prefs-guest@example.test");
    const scopes = ["operator.read", "operator.write"];
    const client = createOperatorClient({ profileId: owner.id, scopes });
    const context = createContext();
    const descriptors = createCoreGatewayMethodDescriptors({
      "users.prefs.get": usersHandlers["users.prefs.get"]!,
      "users.prefs.set": usersHandlers["users.prefs.set"]!,
    });
    context.getGatewayMethodRegistry = () => createGatewayMethodRegistry(descriptors);
    await withOperatorToolGatewayAuthority(
      { authenticatedUserProfile: client.authenticatedUserProfile!, scopes },
      () =>
        withPersonalToolTurn(
          {
            owner: { profileId: owner.id, senderId: "owner", name: "Owner" },
            allowCollaborativeSteering: true,
          },
          (turn) =>
            run({
              ownerId: owner.id,
              steer: async () => {
                expect(
                  await turn.steer({ profileId: guest.id, senderId: "guest", name: "Guest" }),
                ).toMatchObject({ status: "accepted" });
              },
              revoke: () => turn.revoke(owner.id),
              request: (method, params = {}) =>
                dispatchGatewayMethodInProcess(method, params, {
                  forceSyntheticClient: true,
                  resolveGatewayContext: () => context,
                }),
            }),
        ),
    );
  });
}

test("users.prefs rejects mixed-person synthetic turn calls before reading or writing preferences", async () => {
  await withPreferenceToolTurn(async ({ ownerId, steer, request }) => {
    await expect(request("users.prefs.set", { entries: { "ui.theme": "claw" } })).resolves.toEqual({
      status: "ok",
    });
    await expect(request("users.prefs.get")).resolves.toEqual({
      status: "ok",
      entries: { "ui.theme": "claw" },
    });
    await steer();
    using read = vi.spyOn(preferences, "getCanonicalUserPreferences");
    using write = vi.spyOn(preferences, "setCanonicalUserPreferences");
    await withGatewayPersonalToolUser(ownerId, async () => {
      await expect(request("users.prefs.get")).rejects.toThrow(/own Control UI turn/i);
      await expect(request("users.prefs.set", { entries: { "ui.theme": "dark" } })).rejects.toThrow(
        /own Control UI turn/i,
      );
    });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

test.each(["read", "write"] as const)(
  "users.prefs rejects a steer accepted while the personal %s is pending",
  async (operation) => {
    await withPreferenceToolTurn(async ({ ownerId, steer, request }) => {
      await request("users.prefs.set", { entries: { "ui.theme": "claw" } });
      using gate = createRequestGate();
      const readPreferences = preferences.getCanonicalUserPreferences;
      const writePreferences = preferences.setCanonicalUserPreferences;
      using read = vi.spyOn(preferences, "getCanonicalUserPreferences");
      using write = vi.spyOn(preferences, "setCanonicalUserPreferences");
      if (operation === "read") {
        read.mockImplementationOnce(async (...args) => {
          const result = await readPreferences(...args);
          await gate.pause();
          return result;
        });
      } else {
        write.mockImplementationOnce(async (...args) => {
          await gate.pause();
          return writePreferences(...args);
        });
      }
      const pending = request(
        operation === "read" ? "users.prefs.get" : "users.prefs.set",
        operation === "read" ? {} : { entries: { "ui.theme": "dark" } },
      );
      const outcome = Promise.allSettled([pending]);
      await gate.during(
        pending,
        async () => {
          expect(operation === "read" ? read : write).toHaveBeenCalledOnce();
          await steer();
        },
        outcome,
      );
      expect(await outcome).toMatchObject([
        { status: "rejected", reason: { message: expect.stringMatching(/own Control UI turn/i) } },
      ]);
      expect(await readPreferences(ownerId)).toMatchObject({ entries: { "ui.theme": "claw" } });
    });
  },
);

test("users.prefs refuses a pending write when the participant is revoked before worker commit", async () => {
  await withPreferenceToolTurn(async ({ ownerId, revoke, request }) => {
    await request("users.prefs.set", { entries: { "ui.theme": "claw" } });
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let reachedCommit = false;
    using admission = vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission");
    admission.mockImplementation((admit, attachment) =>
      createAdmission((workerRequest, grant) => {
        if (workerRequest.stage === "commit") {
          reachedCommit = true;
          revoke();
        }
        admit(workerRequest, grant);
      }, attachment),
    );
    await expect(request("users.prefs.set", { entries: { "ui.theme": "dark" } })).rejects.toThrow();
    expect(reachedCommit).toBe(true);
    expect(await preferences.getCanonicalUserPreferences(ownerId)).toMatchObject({
      entries: { "ui.theme": "claw" },
    });
  });
});

test.each(["current", "scope", "source", "identity", "staff"] as const)(
  "users.self keeps its original %s authority through the handler's identity sync",
  async (change) => {
    await withPreferenceState(async (prepareProfiles) => {
      const owner = ensureProfileForEmail("self-reader@example.test");
      const replacement = ensureProfileForEmail("other-reader@example.test");
      await prepareProfiles();
      const client = createOperatorWsClient({
        connId: "self-reader",
        scopes: [change === "staff" ? "operator.read" : "operator.sessions.read"],
      });
      client.authenticatedUserId = "self-reader@github";
      const attach = (profile: typeof owner) => attachProfile(client, profile);
      if (change === "staff") {
        attach(owner);
      }
      using gate = createRequestGate();
      let syncCount = 0;
      const sync = vi.fn(async () => {
        syncCount += 1;
        if (change !== "staff" && syncCount === 1) {
          attach(owner);
        } else {
          await gate.pause();
        }
        return { profileId: owner.id, updatedAt: owner.updatedAt };
      });
      client.authenticatedGitHubIdentitySync = sync;
      let current = true;
      const { respond, request } = dispatch(client, "users.self", {}, undefined, () => current);
      const outcome = Promise.allSettled([request]);
      await gate.during(
        request,
        () => {
          expect(sync).toHaveBeenCalledTimes(change === "staff" ? 1 : 2);
          expect(respond).not.toHaveBeenCalled();
          if (change === "scope") {
            client.connect.scopes = [];
          } else if (change === "source") {
            current = false;
          } else if (change === "identity") {
            attach(replacement);
          }
        },
        outcome,
      );
      if (change === "source") {
        expect(await outcome).toMatchObject([
          { status: "rejected", reason: { message: "Gateway requester authority changed" } },
        ]);
        expect(respond).not.toHaveBeenCalled();
      } else {
        expect(await outcome).toEqual([{ status: "fulfilled", value: undefined }]);
        if (change === "current" || change === "staff") {
          expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
            profile: expect.objectContaining({ id: owner.id }),
          });
        } else {
          expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, forbidden);
        }
      }
    }, true);
  },
);

test("users.prefs.get retains its original scope across the preference read", async () => {
  await withPreferenceState(async (prepareProfiles) => {
    const owner = ensureProfileForEmail("retained-preferences@example.test");
    await prepareProfiles();
    await setPrefs(owner.id, { entries: { "ui.theme": "dark" } });
    const client = createOperatorWsClient({
      connId: "preference-reader",
      scopes: ["operator.sessions.read"],
    });
    attachProfile(client, { id: owner.id, updatedAt: 1 });
    using gate = createRequestGate();
    const original = preferences.getCanonicalUserPreferences;
    using read = vi
      .spyOn(preferences, "getCanonicalUserPreferences")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        await gate.pause();
        return result;
      });
    const { respond, request } = dispatch(client, "users.prefs.get");
    const outcome = Promise.allSettled([request]);
    await gate.during(
      request,
      () => {
        expect(read).toHaveBeenCalledOnce();
        client.connect.scopes = [];
      },
      outcome,
    );
    expect(await outcome).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, forbidden);
    expect(await original(owner.id)).toMatchObject({ entries: { "ui.theme": "dark" } });
  }, true);
});

test("users.prefs dispatch saves guest choices only to the authenticated durable profile", async () => {
  return withPreferenceState(async (prepareProfiles) => {
    const ada = ensureProfileForEmail("ada@example.test");
    const grace = ensureProfileForEmail("grace@example.test");
    await prepareProfiles();
    const clients = [ada, grace].map((profile) => {
      const client = createOperatorWsClient({
        connId: profile.id,
        scopes: ["operator.sessions.read", "operator.sessions.write"],
      });
      attachProfile(client, profile);
      return client;
    });
    const adaClient = clients[0]!;
    const graceClient = clients[1]!;
    const notifications = vi.fn();
    const context = createDirectChatContext({
      getRuntimeConfig: () => ({}),
      getClientConnIds: (filter) =>
        new Set(
          clients.filter((client) => !filter || filter(client)).map((client) => client.connId),
        ),
      broadcastToConnIds: notifications,
    });
    const request = async (
      method: string,
      params: Record<string, unknown> = {},
      client = adaClient,
    ) => {
      const { respond, request: pending } = dispatch(client, method, params, context);
      await pending;
      return respond.mock.calls[0];
    };
    const key = "new-session.v1:main";
    const choice = { folder: "/projects/openclaw" };
    const updated = { folder: "/focused-fix" };
    const success = [true, { status: "ok" }, undefined];
    using prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
    expect(await request("users.prefs.set", { entries: { [key]: choice } })).toEqual(success);
    expect(await request("users.prefs.get")).toEqual(preferenceReply({ [key]: choice }));
    expect(await request("users.prefs.get", {}, graceClient)).toEqual(preferenceReply({}));
    notifications.mockClear();
    expect(
      await request("users.prefs.set", {
        entries: { [key]: { folder: "/stale" } },
        expectedEntries: { [key]: null },
      }),
    ).toEqual([true, { status: "conflict" }, undefined]);
    expect(notifications).not.toHaveBeenCalled();
    expect(
      await request("users.prefs.set", {
        entries: { [key]: updated },
        expectedEntries: { [key]: choice },
      }),
    ).toEqual(success);
    expect(notifications).toHaveBeenCalledWith(
      "users.prefs.changed",
      { profileId: ada.id, keys: [key] },
      expect.any(Set),
    );
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();

    expect(
      await request("users.prefs.set", {
        profileId: grace.id,
        entries: { [key]: { folder: "/other" } },
      }),
    ).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
    expect(
      await request("users.prefs.set", {
        entries: { "ui.background": null, [key]: null },
      }),
    ).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("required profile scope") },
    ]);
    expect(await request("themes.set")).toMatchObject([
      false,
      undefined,
      { message: "missing scope: operator.write" },
    ]);
    expect(await request("users.prefs.get", {}, graceClient)).toEqual(preferenceReply({}));
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let reachedCommit = false;
    using admission = vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission");
    admission.mockImplementation((admit, attachment) =>
      createAdmission((workerRequest, grant) => {
        if (workerRequest.stage === "commit") {
          reachedCommit = true;
          adaClient.connect.scopes = [];
        }
        admit(workerRequest, grant);
      }, attachment),
    );
    expect(
      await request("users.prefs.set", { entries: { [key]: { folder: "/revoked" } } }),
    ).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
    expect(reachedCommit).toBe(true);
    expect(await preferences.getCanonicalUserPreferences(ada.id)).toMatchObject({
      entries: { [key]: updated },
    });
    admission.mockRestore();
    linkEmail("ada@example.test", grace.id);
    expect(await request("users.prefs.get", {}, graceClient)).toEqual(
      preferenceReply({ [key]: updated }),
    );
  });
});

test("users.prefs returns a typed result without a durable identity", async () => {
  const context = { broadcastToConnIds: vi.fn(), getClientConnIds: vi.fn() };
  expect(await getPrefs(undefined, {}, context)).toMatchObject({
    ok: true,
    payload: { status: "no_durable_identity" },
  });
  expect(await setPrefs(undefined, { entries: { theme: "claw" } }, context)).toMatchObject({
    ok: true,
    payload: { status: "no_durable_identity" },
  });
  expect(context.getClientConnIds).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalled();
});

test("users.prefs.set notifies only the current merged profile without main-thread profile reads", async () => {
  return withPreferenceState(async (prepareProfiles) => {
    const retired = ensureProfileForEmail("retired@example.test");
    const owner = ensureProfileForEmail("owner@example.test");
    const other = ensureProfileForEmail("other@example.test");
    const avatar = new Uint8Array(64 * 1024).fill(0x7f);
    for (const profile of [retired, owner, other]) {
      expect(setAvatar(profile.id, avatar, "image/png").ok).toBe(true);
    }
    await prepareProfiles();
    linkEmail("retired@example.test", owner.id);

    const peers = [
      ["owner", owner.id, ["operator.sessions.read"]],
      ["merged", retired.id, ["operator.sessions.write"]],
      ["staff", owner.id, ["operator.write"]],
      ["other", other.id, ["operator.sessions.read"]],
      ["unbound", undefined, ["operator.sessions.read"]],
    ] as const;
    const connected = peers.map(([connId, profileId, scopes]) => {
      const frames: string[] = [];
      const socket = createGatewayWsTestSocket({ onSend: (data) => frames.push(data) });
      const client = createOperatorWsClient({ connId, socket, scopes: [...scopes] });
      if (profileId) {
        attachProfile(client, { id: profileId, updatedAt: 1 }, true);
      } else {
        prepareGatewayRecipientProfile(client);
      }
      return { client, frames };
    });
    const clients = new GatewayClientRegistry(connected.map(({ client }) => client));
    const broadcaster = createGatewayBroadcaster({ clients });
    const context = {
      broadcastToConnIds: broadcaster.broadcastToConnIds,
      getClientConnIds: (filter: (client: GatewayClient) => boolean) =>
        new Set([...clients].filter(filter).map((client) => client.connId)),
    };

    // Measure recipient selection on this handle; the preference worker has its own connection.
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(openOpenClawStateDatabase().db),
      ["profiles"],
      (sql) =>
        /^select\b/i.test(sql) && /\bfrom "user_profiles"(?:\s|$)/i.test(sql) ? "profiles" : null,
    );
    try {
      expect(
        await setPrefs(
          retired.id,
          { entries: { "ui.accent": "#A1B2C3", "ui.theme": null } },
          context,
        ),
      ).toMatchObject({ ok: true, payload: { status: "ok" } });
      for (const peer of connected) {
        if (["owner", "merged", "staff"].includes(peer.client.connId)) {
          expect(peer.frames).toHaveLength(1);
          expect(JSON.parse(peer.frames[0]!)).toMatchObject({
            type: "event",
            event: "users.prefs.changed",
            payload: { profileId: owner.id, keys: ["ui.accent", "ui.theme"] },
          });
        } else {
          expect(peer.frames).toEqual([]);
        }
      }
      expect(reads.counts.profiles).toBe(0);
      expect.soft(reads.blobBytes.profiles).toBe(0);
    } finally {
      reads.restore();
    }
  });
});

test("users.prefs.set returns typed profile quota details", async () => {
  return withPreferenceState(async () => {
    const profile = ensureProfileForEmail("quota@example.test");
    for (let start = 0; start < 128; start += 32) {
      const entries = Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`key-${start + index}`, true]),
      );
      expect(await setPrefs(profile.id, { entries })).toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
    }

    expect(await setPrefs(profile.id, { entries: { "key-128": true } })).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: {
          code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
          limit: 128,
          currentCount: 128,
        },
      },
    });
  });
});
import { Worker } from "node:worker_threads";
