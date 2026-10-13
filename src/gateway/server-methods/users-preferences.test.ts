import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import type { SqliteWorkerReply, SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
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
import type { GatewayClient, GatewayRequestHandler } from "./types.js";
import { usersHandlers } from "./users.js";

async function invokePreferenceMethod(
  method: "users.prefs.get" | "users.prefs.set",
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

test("users.prefs returns updated preferences when a write commits before read delivery", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "prefs-publication-",
  });
  try {
    const profileId = ensureProfileForEmail("reader@example.test").id;
    await preferences.setCanonicalUserPreferences(profileId, { "ui.accent": "#112233" });
    const executeRead = stateRead.executeExistingOpenClawStateRead;
    using read = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
    read.mockImplementationOnce(async (readOptions, command, scope) => {
      const reply = await executeRead(readOptions, command, scope);
      await preferences.setCanonicalUserPreferences(profileId, { "ui.accent": "#aabbcc" });
      return reply;
    });

    expect(
      await invokePreferenceMethod("users.prefs.get", { keys: ["ui.accent"] }, profileId),
    ).toEqual({
      ok: true,
      payload: { status: "ok", entries: { "ui.accent": "#aabbcc" } },
      error: undefined,
    });
  } finally {
    await state.cleanup();
  }
});

test("users.prefs reads merged-profile accents while an unrelated writer reply is pending", async ({
  signal,
}) => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "prefs-reader-" });
  try {
    const source = ensureProfileForEmail("source@example.test").id;
    const target = ensureProfileForEmail("target@example.test").id;
    await preferences.setCanonicalUserPreferences(source, {
      "ui.accent": "#a1b2c3",
      other: "excluded",
    });
    mergeProfiles(source, target);
    const context = captureOpenClawStateWorkerContext();
    const readWriterObservation = () =>
      executeOpenClawStateWorker(context, {
        type: "deviceAuth.read",
        input: { deviceId: "preference-reader-test", role: "operator", readOnly: false },
      });
    await readWriterObservation();
    const replyReady = createDeferredCore();
    let publish: (() => void) | undefined;
    let selected: { worker: Worker; id: number } | undefined;
    // oxlint-disable-next-line typescript/unbound-method -- Forward with the intercepted worker receiver.
    const originalPost = Worker.prototype.postMessage;
    // oxlint-disable-next-line typescript/unbound-method -- Forward with the intercepted worker receiver.
    const originalEmit = Worker.prototype.emit;
    const requests = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command: unknown = deserialize(request.input);
        if (
          isRecord(command) &&
          command.type === "deviceAuth.read" &&
          isRecord(command.input) &&
          command.input.deviceId === "preference-reader-test"
        ) {
          selected = { worker: this, id: request.id };
        }
      }
      return originalPost.call(this, request, transferList);
    });
    const replies = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      reply: SqliteWorkerReply,
    ) {
      if (event === "message" && this === selected?.worker && reply.id === selected.id) {
        publish = () => originalEmit.call(this, event, reply);
        replyReady.resolve();
        return true;
      }
      return originalEmit.call(this, event, reply);
    });
    const pendingWriter = readWriterObservation();
    try {
      await withinTest(replyReady.promise, signal);
      expect(
        await withinTest(
          invokePreferenceMethod("users.prefs.get", { keys: ["ui.accent"] }, source),
          signal,
        ),
      ).toEqual({
        ok: true,
        payload: { status: "ok", entries: { "ui.accent": "#a1b2c3" } },
        error: undefined,
      });
    } finally {
      replies.mockRestore();
      requests.mockRestore();
      publish?.();
      await pendingWriter;
    }
  } finally {
    await state.cleanup();
  }
});

async function withPreferenceToolTurn(
  run: (params: {
    ownerId: string;
    guestId: string;
    steer: () => Promise<void>;
    revoke: () => void;
    request: (
      method: "users.prefs.get" | "users.prefs.set",
      params?: Record<string, unknown>,
    ) => Promise<unknown>;
  }) => Promise<void>,
) {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "prefs-tool-turn-" });
  try {
    const owner = ensureProfileForEmail("prefs-owner@example.test");
    const guest = ensureProfileForEmail("prefs-guest@example.test");
    const scopes = ["operator.read", "operator.write"];
    const client = createOperatorClient({ profileId: owner.id, scopes });
    const context = createContext();
    const expectSyntheticOwnerCall = (
      method: "users.prefs.get" | "users.prefs.set",
    ): GatewayRequestHandler => {
      const handler = usersHandlers[method];
      if (!handler) {
        throw new Error(`missing ${method} handler`);
      }
      return (options) => {
        expect(options.client?.internal?.syntheticClient).toBe(true);
        expect(options.client?.authenticatedUserProfile?.profileId).toBe(owner.id);
        return handler(options);
      };
    };
    const descriptors = createCoreGatewayMethodDescriptors({
      "users.prefs.get": expectSyntheticOwnerCall("users.prefs.get"),
      "users.prefs.set": expectSyntheticOwnerCall("users.prefs.set"),
    });
    context.getGatewayMethodRegistry = () => createGatewayMethodRegistry(descriptors);
    await withOperatorToolGatewayAuthority(
      { authenticatedUserProfile: client.authenticatedUserProfile!, scopes },
      () =>
        withPersonalToolTurn(
          { owner: { profileId: owner.id, senderId: "owner", name: "Owner" } },
          (turn) =>
            run({
              ownerId: owner.id,
              guestId: guest.id,
              steer: async () => {
                expect(
                  await turn.steer({ profileId: guest.id, senderId: "guest", name: "Guest" }),
                ).toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
                expect(turn.operation.personalToolParticipants?.resolve()?.profileId).toBe(
                  owner.id,
                );
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
  } finally {
    await state.cleanup();
  }
}

test("users.prefs keeps personal calls with the owner after rejecting another requester", async () => {
  await withPreferenceToolTurn(async ({ ownerId, guestId, steer, request }) => {
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
    await withGatewayPersonalToolUser(guestId, async () => {
      await expect(request("users.prefs.get")).rejects.toThrow(/not a participant/i);
      await expect(request("users.prefs.set", { entries: { "ui.theme": "dark" } })).rejects.toThrow(
        /not a participant/i,
      );
    });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await withGatewayPersonalToolUser(ownerId, async () => {
      await expect(request("users.prefs.get")).resolves.toEqual({
        status: "ok",
        entries: { "ui.theme": "claw" },
      });
      await expect(
        request("users.prefs.set", { entries: { "ui.theme": "dark" } }),
      ).resolves.toEqual({ status: "ok" });
    });
    expect(await preferences.getCanonicalUserPreferences(ownerId)).toMatchObject({
      entries: { "ui.theme": "dark" },
    });
    expect(await preferences.getCanonicalUserPreferences(guestId)).toMatchObject({ entries: {} });
  });
});

test.each(["read", "write"] as const)(
  "users.prefs preserves its requester when another person steers during a pending %s",
  async (operation) => {
    await withPreferenceToolTurn(async ({ ownerId, steer, request }) => {
      await request("users.prefs.set", { entries: { "ui.theme": "claw" } });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const readPreferences = preferences.getCanonicalUserPreferences;
      const writePreferences = preferences.setCanonicalUserPreferences;
      using read = vi.spyOn(preferences, "getCanonicalUserPreferences");
      using write = vi.spyOn(preferences, "setCanonicalUserPreferences");
      if (operation === "read") {
        read.mockImplementationOnce(async (...args) => {
          const result = await readPreferences(...args);
          entered.resolve();
          await release.promise;
          return result;
        });
      } else {
        write.mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return writePreferences(...args);
        });
      }
      const pending = request(
        operation === "read" ? "users.prefs.get" : "users.prefs.set",
        operation === "read" ? {} : { entries: { "ui.theme": "dark" } },
      );
      const outcome = Promise.allSettled([pending]);
      try {
        await Promise.race([entered.promise, pending]);
        expect(operation === "read" ? read : write).toHaveBeenCalledOnce();
        await steer();
      } finally {
        release.resolve();
        await outcome;
      }
      expect(await outcome).toEqual([
        {
          status: "fulfilled",
          value:
            operation === "read"
              ? { status: "ok", entries: { "ui.theme": "claw" } }
              : { status: "ok" },
        },
      ]);
      expect(await readPreferences(ownerId)).toMatchObject({
        entries: { "ui.theme": operation === "read" ? "claw" : "dark" },
      });
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

test.each(["current", "read", "scope", "source", "identity", "error-response", "staff"] as const)(
  "users.self keeps its original %s authority through the handler's identity sync",
  async (change) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "users-self-read-",
    });
    setRuntimeConfigSnapshot({});
    let releaseProfiles: (() => void) | undefined;
    try {
      setRuntimeConfigSnapshot({});
      const owner = ensureProfileForEmail("self-reader@example.test");
      const replacement = ensureProfileForEmail("other-reader@example.test");
      releaseProfiles = (await prepareUserProfileCatalog()).release;
      const client = createOperatorWsClient({
        connId: "self-reader",
        scopes: [
          change === "staff" || change === "read" ? "operator.read" : "operator.sessions.read",
        ],
      });
      client.authenticatedUserId = "self-reader@github";
      const attach = (profile: typeof owner) => {
        client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: null,
          avatarRevision: "",
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        prepareGatewayRecipientProfile(client);
      };
      if (change === "staff") {
        attach(owner);
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let syncCount = 0;
      const sync = vi.fn(async () => {
        syncCount += 1;
        if (change !== "staff" && syncCount === 1) {
          attach(owner);
        } else {
          entered.resolve();
          await release.promise;
        }
        return { profileId: owner.id, updatedAt: owner.updatedAt };
      });
      client.authenticatedGitHubIdentitySync = sync;
      let current = true;
      const respond = vi.fn();
      const request = handleGatewayRequest({
        req: { type: "req", id: change, method: "users.self", params: {} },
        client,
        context: createDirectChatContext(),
        respond,
        hasCurrentClientAuthority: () => current,
        isWebchatConnect: () => false,
        extraHandlers: usersHandlers,
      });
      const outcome = Promise.allSettled([request]);
      try {
        await Promise.race([entered.promise, request]);
        expect(sync).toHaveBeenCalledTimes(change === "staff" ? 1 : 2);
        expect(respond).not.toHaveBeenCalled();
        if (change === "scope") {
          client.connect.scopes = [];
        } else if (change === "source") {
          current = false;
        } else if (change === "identity") {
          attach(replacement);
        } else if (change === "error-response") {
          client.authenticatedUserProfile = undefined;
        }
      } finally {
        release.resolve();
        await outcome;
      }
      if (change === "source") {
        expect(await outcome).toMatchObject([
          { status: "rejected", reason: { message: "Gateway requester authority changed" } },
        ]);
        expect(respond).not.toHaveBeenCalled();
      } else {
        expect(await outcome).toEqual([{ status: "fulfilled", value: undefined }]);
        if (change === "current" || change === "read" || change === "staff") {
          expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
            profile: expect.objectContaining({ id: owner.id }),
          });
        } else {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              code: "FORBIDDEN",
              message: "Gateway requester authority changed",
            }),
          );
        }
      }
    } finally {
      releaseProfiles?.();
      clearRuntimeConfigSnapshot();
      await state.cleanup();
    }
  },
);

test("users.prefs.get retains its original scope across the preference read", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-read-",
  });
  setRuntimeConfigSnapshot({});
  let releaseProfiles: (() => void) | undefined;
  try {
    setRuntimeConfigSnapshot({});
    const owner = ensureProfileForEmail("retained-preferences@example.test");
    releaseProfiles = (await prepareUserProfileCatalog()).release;
    await invokePreferenceMethod("users.prefs.set", { entries: { "ui.theme": "dark" } }, owner.id);
    const client = createOperatorWsClient({
      connId: "preference-reader",
      scopes: ["operator.sessions.read"],
    });
    client.authenticatedUserProfile = {
      profileId: owner.id,
      displayName: null,
      avatarRevision: "",
      hasAvatar: false,
      updatedAt: 1,
    };
    prepareGatewayRecipientProfile(client);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const original = preferences.getCanonicalUserPreferences;
    using read = vi
      .spyOn(preferences, "getCanonicalUserPreferences")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
    const respond = vi.fn();
    const request = handleGatewayRequest({
      req: { type: "req", id: "retained-preferences", method: "users.prefs.get", params: {} },
      client,
      context: createDirectChatContext(),
      respond,
      isWebchatConnect: () => false,
      extraHandlers: usersHandlers,
    });
    const outcome = Promise.allSettled([request]);
    try {
      await Promise.race([entered.promise, request]);
      expect(read).toHaveBeenCalledOnce();
      client.connect.scopes = [];
    } finally {
      release.resolve();
      await outcome;
    }
    expect(await outcome).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "Gateway requester authority changed",
      }),
    );
    expect(await original(owner.id)).toMatchObject({ entries: { "ui.theme": "dark" } });
  } finally {
    releaseProfiles?.();
    clearRuntimeConfigSnapshot();
    await state.cleanup();
  }
});

test("users.prefs dispatch saves guest choices only to the authenticated durable profile", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-prefs-rpc-" });
  let releaseProfiles: (() => void) | undefined;
  try {
    const ada = ensureProfileForEmail("ada@example.test");
    const grace = ensureProfileForEmail("grace@example.test");
    releaseProfiles = (await prepareUserProfileCatalog()).release;
    const clients = [ada, grace].map((profile) => {
      const client = createOperatorWsClient({
        connId: profile.id,
        scopes: ["operator.sessions.read", "operator.sessions.write"],
      });
      client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: null,
        avatarRevision: "",
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      };
      prepareGatewayRecipientProfile(client);
      return client;
    });
    const adaClient = clients[0]!;
    const graceClient = clients[1]!;
    const context = createDirectChatContext({
      getRuntimeConfig: () => ({}),
      getClientConnIds: (filter) =>
        new Set(
          clients.filter((client) => !filter || filter(client)).map((client) => client.connId),
        ),
      broadcastToConnIds: vi.fn(),
    });
    const request = async (
      method: string,
      params: Record<string, unknown> = {},
      client = adaClient,
    ) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: method, method, params },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: usersHandlers,
      });
      expect(respond).toHaveBeenCalledOnce();
      return respond.mock.calls[0];
    };
    const key = "new-session.v1:main";
    const choice = { folder: "/projects/openclaw", worktree: true };
    using prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
    expect(await request("users.prefs.set", { entries: { [key]: choice } })).toEqual([
      true,
      { status: "ok" },
      undefined,
    ]);
    expect(await request("users.prefs.get")).toEqual([
      true,
      { status: "ok", entries: { [key]: choice } },
      undefined,
    ]);
    expect(await request("users.prefs.get", {}, graceClient)).toEqual([
      true,
      { status: "ok", entries: {} },
      undefined,
    ]);
    expect(
      await request("users.prefs.set", {
        entries: { [key]: { folder: "/stale" } },
        expectedEntries: { [key]: null },
      }),
    ).toEqual([true, { status: "conflict" }, undefined]);
    expect(
      await request("users.prefs.set", {
        entries: { [key]: { ...choice, worktreeName: "focused-fix" } },
        expectedEntries: { [key]: choice },
      }),
    ).toEqual([true, { status: "ok" }, undefined]);
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
    for (const [method, scope] of [
      ["themes.set", "operator.write"],
      ["users.setRole", "operator.admin"],
    ] as const) {
      expect(await request(method)).toMatchObject([
        false,
        undefined,
        { message: `missing scope: ${scope}` },
      ]);
    }
    expect(await request("users.prefs.get", {}, graceClient)).toEqual([
      true,
      { status: "ok", entries: {} },
      undefined,
    ]);
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
      entries: { [key]: { ...choice, worktreeName: "focused-fix" } },
    });
    admission.mockRestore();
    linkEmail("ada@example.test", grace.id);
    expect(await request("users.prefs.get", {}, graceClient)).toEqual([
      true,
      { status: "ok", entries: { [key]: { ...choice, worktreeName: "focused-fix" } } },
      undefined,
    ]);
  } finally {
    releaseProfiles?.();
    await state.cleanup();
  }
});

test("users.prefs returns a typed result without a durable identity", async () => {
  const context = { broadcastToConnIds: vi.fn(), getClientConnIds: vi.fn() };
  expect(await invokePreferenceMethod("users.prefs.get", {}, undefined, context)).toMatchObject({
    ok: true,
    payload: { status: "no_durable_identity" },
  });
  expect(
    await invokePreferenceMethod(
      "users.prefs.set",
      { entries: { theme: "claw" } },
      undefined,
      context,
    ),
  ).toMatchObject({
    ok: true,
    payload: { status: "no_durable_identity" },
  });
  expect(context.getClientConnIds).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalled();
});

test("users.prefs.set notifies only the current merged profile without main-thread profile reads", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-events-",
  });
  let releaseProfiles: (() => void) | undefined;
  try {
    const retired = ensureProfileForEmail("retired@example.test");
    const owner = ensureProfileForEmail("owner@example.test");
    const other = ensureProfileForEmail("other@example.test");
    const avatar = new Uint8Array(64 * 1024).fill(0x7f);
    for (const profile of [retired, owner, other]) {
      expect(setAvatar(profile.id, avatar, "image/png").ok).toBe(true);
    }
    releaseProfiles = (await prepareUserProfileCatalog()).release;
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
        client.authenticatedUserProfile = {
          profileId,
          displayName: null,
          avatarRevision: "",
          hasAvatar: true,
          updatedAt: 1,
        };
      }
      prepareGatewayRecipientProfile(client);
      return { client, frames };
    });
    const clients = new GatewayClientRegistry(connected.map(({ client }) => client));
    const broadcaster = createGatewayBroadcaster({ clients });
    const broadcastToConnIds = vi.fn(broadcaster.broadcastToConnIds);
    const context = {
      broadcastToConnIds,
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
        await invokePreferenceMethod(
          "users.prefs.set",
          { entries: { "ui.accent": "#A1B2C3", "ui.theme": null } },
          retired.id,
          context,
        ),
      ).toMatchObject({ ok: true, payload: { status: "ok" } });
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "users.prefs.changed",
        { profileId: owner.id, keys: ["ui.accent", "ui.theme"] },
        new Set(["owner", "merged", "staff"]),
      );
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
  } finally {
    releaseProfiles?.();
    await state.cleanup();
  }
});

test("users.prefs.set returns typed profile quota details", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-quota-",
  });
  try {
    const profile = ensureProfileForEmail("quota@example.test");
    for (let start = 0; start < 128; start += 32) {
      const entries = Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`key-${start + index}`, true]),
      );
      expect(
        await invokePreferenceMethod("users.prefs.set", { entries }, profile.id),
      ).toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
    }

    expect(
      await invokePreferenceMethod("users.prefs.set", { entries: { "key-128": true } }, profile.id),
    ).toMatchObject({
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
  } finally {
    await state.cleanup();
  }
});

test("users.prefs.set compares canonical preferences atomically and publishes only committed writes", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-conditional-",
  });
  let releaseProfiles: (() => void) | undefined;
  try {
    const retired = ensureProfileForEmail("conditional-retired@example.test");
    const owner = ensureProfileForEmail("conditional-owner@example.test");
    releaseProfiles = (await prepareUserProfileCatalog()).release;
    const original = {
      selection: { folder: "/new", model: "new", nested: [1, { a: 2, b: 3 }] },
      removed: true,
    };
    expect(
      await invokePreferenceMethod("users.prefs.set", { entries: original }, owner.id),
    ).toMatchObject({
      ok: true,
      payload: { status: "ok" },
    });
    linkEmail("conditional-retired@example.test", owner.id);
    const context = {
      broadcastToConnIds: vi.fn(),
      getClientConnIds: vi.fn(() => new Set(["owner"])),
    };
    for (const entries of [{ removed: null, inserted: true }, {}]) {
      expect(
        await invokePreferenceMethod(
          "users.prefs.set",
          {
            entries,
            expectedEntries: { selection: { folder: "/old" } },
          },
          retired.id,
          context,
        ),
      ).toEqual({ ok: true, payload: { status: "conflict" }, error: undefined });
    }
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(context.getClientConnIds).not.toHaveBeenCalled();
    expect(await invokePreferenceMethod("users.prefs.get", {}, owner.id)).toMatchObject({
      payload: { status: "ok", entries: original },
    });
    expect(
      await invokePreferenceMethod(
        "users.prefs.set",
        {
          entries: { removed: null, inserted: true },
          expectedEntries: {
            selection: { nested: [1, { b: 3, a: 2 }], model: "new", folder: "/new" },
            inserted: null,
          },
        },
        retired.id,
        context,
      ),
    ).toEqual({ ok: true, payload: { status: "ok" }, error: undefined });
    expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "users.prefs.changed",
      { profileId: owner.id, keys: ["removed", "inserted"] },
      new Set(["owner"]),
    );
    expect(await invokePreferenceMethod("users.prefs.get", {}, owner.id)).toMatchObject({
      payload: { status: "ok", entries: { selection: original.selection, inserted: true } },
    });
  } finally {
    releaseProfiles?.();
    await state.cleanup();
  }
});
