import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { resolveProfileOverride } from "../auto-reply/reply/directive-handling.auth-profile.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerRequest,
} from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  connectUserModelAccountAsync,
  clearUserProfileAuthLinkAsync,
  listUserModelAccountsAsync,
  listUserProfileAuthLinksAsync,
  setUserProfileAuthLinkAsync,
} from "../state/user-model-account-operations.js";
import {
  readUserModelAuthProfile,
  setUserProfileAuthLink as setLinkSync,
  updateUserModelAuthProfile,
} from "../state/user-model-accounts.js";
import { isUserProfileCatalogReady } from "../state/user-profile-list.js";
import {
  linkEmail,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { WizardSession } from "../wizard/session.js";
import { ModelAccountConnectAuthorityError } from "./model-account-connect-errors.js";
import { createModelAccountConnectService } from "./model-account-connect.js";
import type { RespondFn } from "./server-methods/types.js";
import { usersAuthConnectHandlers } from "./server-methods/users-auth-connect.js";
import {
  preparePersonalModelAccountSelection,
  prepareUserModelAccountAction,
} from "./server-methods/users-model-account-access.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

const resolveMethod = vi.hoisted(() => vi.fn());
const runAuth = vi.hoisted(() => vi.fn());
vi.mock("../plugins/personal-account-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/personal-account-auth.js")>()),
  listPersonalAccountAuthChoices: () => [],
  resolvePersonalAccountAuthMethod: resolveMethod,
}));
vi.mock("../plugins/provider-auth-method.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-auth-method.js")>()),
  runProviderPluginAuthMethodUnpersisted: runAuth,
}));

afterEach(() => vi.restoreAllMocks());

const credential: AuthProfileCredential = {
  type: "token",
  provider: "synthetic",
  token: "synthetic-private-account-token",
};
const authority = { assertCurrent() {} };
const connectAccount = (
  ownerProfileId: string,
  overrides: Partial<Parameters<typeof connectUserModelAccountAsync>[0]> = {},
) => connectUserModelAccountAsync({ ownerProfileId, credential, ...authority, ...overrides });
const role = (scopes: GatewayOperatorRoleDefinition["scopes"]): GatewayOperatorRoleDefinition => ({
  agents: [],
  scopes,
  sessions: { others: "none" },
});
const withAccount = (email: string, run: (owner: string) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, () => run(ensureProfileForEmail(email).id));
const operator = (profileId: string) =>
  createOperatorClient({
    profileId,
    scopes: ["operator.read", "operator.write", "operator.admin"],
  });
const resolvePin = (rawProfile: string, requesterProfileId: string) =>
  resolveProfileOverride({ rawProfile, provider: credential.provider, requesterProfileId });
const rolesConfig = (
  roles: NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>,
): OpenClawConfig => ({ gateway: { roles } });
const expectLinked = async (owner: string, authProfileId: string) =>
  expect(await listUserProfileAuthLinksAsync(owner)).toMatchObject([{ authProfileId }]);

async function withoutSql<T>(run: () => T | Promise<T>): Promise<T> {
  const sql = observeHostDataSql();
  try {
    const result = await run();
    expect(sql.queries).toEqual([]);
    return result;
  } finally {
    sql.restore();
  }
}

function calibrateSql(queries: string[]) {
  const db = new DatabaseSync(":memory:");
  try {
    db.prepare("SELECT 1").get();
    expect(queries).toContain("SELECT 1");
  } finally {
    db.close();
  }
  queries.length = 0;
}

function observeGrantSql() {
  let active = false;
  const queries: string[] = [];
  const sql = observeHostDataSql((query) => {
    if (active) {
      queries.push(query);
    }
  });
  const within = (run: () => void) => {
    active = true;
    try {
      run();
    } finally {
      active = false;
    }
  };
  return { queries, within, restore: () => sql.restore() };
}

function accountContext(
  client: ReturnType<typeof createOperatorClient>,
  getRuntimeConfig = (): OpenClawConfig => ({}),
  isConnected = () => true,
) {
  const context = createContext();
  context.getRuntimeConfig = getRuntimeConfig;
  context.getClientConnIds = (filter) =>
    new Set(isConnected() && client.connId && (!filter || filter(client)) ? [client.connId] : []);
  return context;
}

async function callAccount(
  client: ReturnType<typeof createOperatorClient>,
  context: ReturnType<typeof createContext>,
  method: string,
  params: Record<string, unknown>,
) {
  const handler = usersAuthConnectHandlers[method];
  if (!handler) {
    throw new Error(`Missing account handler: ${method}`);
  }
  const respond = vi.fn<RespondFn>();
  await handler({
    req: { type: "req", id: "account-boundary", method, params },
    params,
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond;
}

it("prepares cold personal account policy with GitHub assignments and current role authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = syncGitHubIdentity({
      identity: { accountId: 12345, login: "account-owner" },
      authenticationAlias: { kind: "email", email: "cold-account-owner@example.test" },
    }).id;
    const client = createOperatorClient({ profileId: owner, scopes: ["operator.write"] });
    const writer: GatewayOperatorRoleDefinition = { ...role(["operator.write"]), agents: "*" };
    const cfg = rolesConfig({
      default: "denied",
      definitions: { denied: role([]), writer },
      assignments: { byGithubLogin: { "account-owner": "writer" } },
    });
    const context = accountContext(client, () => cfg);

    expect(isUserProfileCatalogReady()).toBe(false);
    const action = await prepareUserModelAccountAction({ client, context });
    expect(action.owner).toBe(owner);
    expect(() => action.assertCurrent()).not.toThrow();
    expect(() => action.assertCurrent([{ profileId: owner, role: "denied" }])).toThrow(
      ModelAccountConnectAuthorityError,
    );
    expect(() => action.assertCurrent([{ profileId: owner, role: null }])).not.toThrow();

    writer.scopes = [];
    expect(() => action.assertCurrent()).toThrow(ModelAccountConnectAuthorityError);
    writer.scopes = ["operator.write"];
    setUserProfileRole(owner, "denied");
    expect(() => action.assertCurrent()).toThrow(ModelAccountConnectAuthorityError);
  });
});

it("prepares personal account ownership from the next foreign commit", () =>
  withAccount("pin-freshness@example.test", async (owner) => {
    const { authProfileId } = await connectAccount(owner);
    expect((await resolvePin(authProfileId, owner)).profileId).toBe(authProfileId);
    const foreign = new DatabaseSync(resolveOpenClawStateSqlitePath());
    try {
      foreign
        .prepare(
          "DELETE FROM secret_store_entries WHERE scope_kind = 'identity' AND scope_id = ? AND name = ?",
        )
        .run(owner, `model-account:${authProfileId}`);
      expect(await resolvePin(authProfileId, owner)).toMatchObject({
        error: expect.stringContaining("signed-in profile"),
      });
    } finally {
      foreign.close();
    }
  }));

it("prepares and validates personal pins without caller SQL, retaining identity authority", () =>
  withAccount("pin-owner@example.test", async (owner) => {
    const successor = ensureProfileForEmail("pin-successor@example.test").id;
    const { authProfileId } = await connectAccount(owner);
    const selected = await withoutSql(async () => {
      const pin = await resolvePin(authProfileId, owner);
      expect(pin.profileId).toBe(authProfileId);
      expect(pin.validateSelection?.()).toBeUndefined();
      expect(await resolvePin(authProfileId, successor)).toMatchObject({
        error: expect.stringContaining("signed-in profile"),
      });
      return pin;
    });
    await clearUserProfileAuthLinkAsync({
      profileId: owner,
      provider: credential.provider,
      ...authority,
    });
    expect(selected.validateSelection?.()).toBeUndefined();
    linkEmail("pin-owner@example.test", successor);
    await withoutSql(() => {
      expect(selected.validateSelection?.()).toContain("signed-in profile");
    });
  }));

it("rejects a pin whose identity changed before an awaited account read was accepted", ({
  signal,
}) =>
  withAccount("pin-read-owner@example.test", async (owner) => {
    const successor = ensureProfileForEmail("pin-read-successor@example.test").id;
    const { authProfileId } = await connectAccount(owner);
    const client = operator(owner);
    const context = accountContext(client);
    const scanned = createDeferredCore();
    const consume = createDeferredCore();
    const read = stateReads.executeExistingOpenClawStateRead;
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[1].type === "userModelAccounts.summary") {
        scanned.resolve();
        await consume.promise;
      }
      return result;
    });
    const pending = preparePersonalModelAccountSelection({ client, context }, authProfileId);
    const refused = expect(pending).rejects.toBeInstanceOf(ModelAccountConnectAuthorityError);
    try {
      await withinTest(
        awaitGateBeforeSettlement(scanned.promise, pending, "Pin settled before its account read"),
        signal,
      );
      linkEmail("pin-read-owner@example.test", successor);
    } finally {
      consume.resolve();
    }
    await refused;
  }));

function observeAccountAdmission(observer: (stage: "transaction" | "commit") => void) {
  return probe.admission(workerAdmission, (request, grant, admit) => {
    if (
      isRecord(request.facts) &&
      request.facts.kind === "model-account-links" &&
      (request.stage === "transaction" || request.stage === "commit")
    ) {
      observer(request.stage);
    }
    admit(request, grant);
  });
}

it("serves personal account RPCs without caller-thread SQL or credentials", ({ signal }) =>
  withAccount("worker-accounts@example.test", async (owner) => {
    const client = operator(owner);
    const clients = new Set([client]);
    const context = accountContext(client, undefined, () => clients.has(client));
    const changed = createDeferredCore();
    const settled = createDeferredCore();
    const committed = createDeferredCore();
    const deliverCommit = createDeferredCore();
    probe.command(stateWorker, async (command, executeOptions, scope) => {
      const result = await scope.execute(command, executeOptions);
      if (command.type === "userProfiles.modelAccount.connect") {
        committed.resolve();
        await deliverCommit.promise;
      }
      return result;
    });
    // oxlint-disable-next-line typescript/unbound-method -- The call below retains the intercepted Wizard as receiver.
    const cancel = WizardSession.prototype.cancel;
    const cancellation = vi.spyOn(WizardSession.prototype, "cancel").mockImplementation(function (
      this: WizardSession,
    ) {
      settled.resolve(this.whenSettled());
      return cancel.call(this);
    });
    const authMethod: ProviderAuthMethod = {
      id: "token",
      label: "Synthetic token",
      kind: "token",
      run: async () => ({ profiles: [] }),
    };
    resolveMethod.mockResolvedValue(authMethod);
    runAuth.mockResolvedValue({ profiles: [{ profileId: "ignored-shared-id", credential }] });
    const service = createModelAccountConnectService({
      getConfig: () => ({}),
      onChanged: changed.resolve,
    });
    context.modelAccountConnectService = service;
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const respond = await callAccount(client, context, method, { profileId: owner, ...params });
      const [ok, payload, error] = respond.mock.calls[0] ?? [];
      expect({ ok, error }).toEqual({ ok: true, error: undefined });
      return payload;
    };
    const sql = observeHostDataSql();
    try {
      calibrateSql(sql.queries);
      const started = await rpc("users.authConnect.start", {
        provider: "synthetic",
        method: "token",
      });
      if (!isRecord(started) || typeof started.connectId !== "string") {
        throw new Error("personal account sign-in did not start");
      }
      await withinTest(
        awaitGateBeforeSettlement(
          committed.promise,
          settled.promise,
          "Personal account sign-in settled before committing",
        ),
        signal,
      );
      expect(await rpc("users.authConnect.cancel", { connectId: started.connectId })).toEqual({
        status: "cancelled",
      });
      deliverCommit.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          changed.promise,
          settled.promise,
          "Personal account sign-in settled without publishing a connected account",
        ),
        signal,
      );
      const connected = await rpc("users.authConnect.status", { connectId: started.connectId });
      if (
        !isRecord(connected) ||
        connected.status !== "connected" ||
        typeof connected.authProfileId !== "string"
      ) {
        throw new Error("personal account did not connect");
      }
      const { authProfileId } = connected;
      const link = { provider: "synthetic", authProfileId };
      expect(connected.links).toMatchObject([link]);
      expect(await rpc("users.listModelAccounts")).toMatchObject({
        profileId: owner,
        accounts: [{ ...link, authType: "token", selected: true }],
        links: [link],
      });
      expect(await rpc("users.listAuthLinks")).toMatchObject({ links: [link] });
      expect(await rpc("users.unlinkAuthProfile", { provider: "synthetic" })).toEqual({
        links: [],
      });
      for (const method of ["users.linkAuthProfile", "users.selectModelAccount"]) {
        expect(await rpc(method, { authProfileId })).toMatchObject({ links: [link] });
      }
      expect(JSON.stringify([await rpc("users.listModelAccounts"), connected])).not.toContain(
        credential.token,
      );

      const action = await prepareUserModelAccountAction({ client, context }, owner);
      const staleList = service.listAsync(action);
      clients.clear();
      await expect(staleList).rejects.toBeInstanceOf(ModelAccountConnectAuthorityError);
      clients.add(client);
      const staleStatus = service.statusAsync(action, started.connectId);
      clients.clear();
      await expect(staleStatus).rejects.toBeInstanceOf(ModelAccountConnectAuthorityError);
      expect(sql.queries).toEqual([]);
    } finally {
      deliverCommit.resolve();
      sql.restore();
      cancellation.mockRestore();
      await service.stop();
    }
  }));

it.each(["transaction", "commit"] as const)(
  "uses the stored role to refuse selection when policy enables at %s, without grant SQL",
  (stage) =>
    withAccount("grant-role@example.test", async (owner) => {
      setUserProfileRole(owner, "member");
      const first = await connectAccount(owner);
      const second = await connectAccount(owner);
      const client = createOperatorClient({ profileId: owner, scopes: ["operator.write"] });
      let cfg: OpenClawConfig = {};
      const context = accountContext(client, () => cfg);
      const service = createModelAccountConnectService({ getConfig: () => cfg });
      context.modelAccountConnectService = service;
      const enabled = rolesConfig({
        default: "fallback",
        definitions: { member: role([]), fallback: role(["operator.write"]) },
      });
      const sql = observeGrantSql();
      const stages: string[] = [];
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
        if (!isRecord(request.facts) || request.facts.kind !== "model-account-links") {
          admit(request, grant);
          return;
        }
        stages.push(request.stage);
        if (request.stage === stage) {
          cfg = enabled;
        }
        sql.within(() => admit(request, grant));
      });
      try {
        sql.within(() => calibrateSql(sql.queries));
        const respond = await callAccount(client, context, "users.selectModelAccount", {
          profileId: owner,
          authProfileId: first.authProfileId,
        });
        // The real RPC mapper recognizes the authority error after worker transport.
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        expect(stages).toEqual(
          stage === "transaction" ? ["transaction"] : ["transaction", "commit"],
        );
        expect(sql.queries).toEqual([]);
        await expectLinked(owner, second.authProfileId);
      } finally {
        admission.mockRestore();
        sql.restore();
        await service.stop();
      }
    }),
);

it.each(["transaction", "commit"] as const)(
  "refuses revoked %s authority without committing either credential or link",
  (refusalStage) =>
    withAccount("refused-account@example.test", async (owner) => {
      let live = true;
      const observed: string[] = [];
      const admission = observeAccountAdmission((stage) => {
        observed.push(stage);
        if (stage === refusalStage) {
          live = false;
        }
      });
      try {
        await expect(
          connectAccount(owner, {
            assertCurrent() {
              if (!live) {
                throw new ModelAccountConnectAuthorityError();
              }
            },
          }),
        ).rejects.toBeInstanceOf(ModelAccountConnectAuthorityError);
        expect(observed).toEqual(
          refusalStage === "transaction" ? ["transaction"] : ["transaction", "commit"],
        );
        expect(await listUserModelAccountsAsync({ profileId: owner })).toEqual({ accounts: [] });
        expect(await listUserProfileAuthLinksAsync(owner)).toEqual([]);
      } finally {
        admission.mockRestore();
      }
    }),
);

it.each(["credential", "selection"] as const)(
  "compares before BEGIN and rereads %s account rows inside the transaction",
  (race) =>
    withAccount("replacement-account@example.test", async (owner) => {
      const first = await connectAccount(owner);
      const order: string[] = [];
      const admission = observeAccountAdmission((stage) => order.push(stage));
      try {
        const result = await connectAccount(owner, {
          credential: { ...credential, token: "synthetic-reconnected-token" },
          matchesCredential(current) {
            expect(current).toEqual(credential);
            order.push("compare");
            // A real competing commit here also proves the provider callback does not hold BEGIN.
            if (race === "credential") {
              updateUserModelAuthProfile(first.authProfileId, (profile) => {
                profile.credential = { ...credential, token: "synthetic-concurrent-refresh" };
                return true;
              });
            } else if (race === "selection") {
              setLinkSync({
                profileId: owner,
                provider: "synthetic",
                authProfileId: "synthetic:shared",
              });
            }
            return true;
          },
        });
        expect(order).toEqual(["compare", "transaction", "commit"]);
        expect(result.authProfileId).not.toBe(first.authProfileId);
        expect(readUserModelAuthProfile(first.authProfileId)?.credential).toEqual({
          ...credential,
          token: race === "credential" ? "synthetic-concurrent-refresh" : credential.token,
        });
        expect((await listUserModelAccountsAsync({ profileId: owner })).accounts).toHaveLength(2);
        await expectLinked(owner, result.authProfileId);
      } finally {
        admission.mockRestore();
      }
    }),
);

it("does not replay a committed account mutation whose worker reply is lost", () =>
  withAccount("lost-account-reply@example.test", async (owner) => {
    let target: { worker: Worker; id: number } | undefined;
    let terminated: Promise<number> | undefined;
    let attempts = 0;
    // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
    const originalPost = Worker.prototype.postMessage;
    // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
    const originalEmit = Worker.prototype.emit;
    const posted = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command: unknown = deserialize(request.input);
        if (isRecord(command) && command.type === "userProfiles.modelAccount.link") {
          attempts++;
          target ??= { worker: this, id: request.id };
        }
      }
      return originalPost.call(this, request, transferList);
    });
    const emitted = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event,
      ...args: unknown[]
    ) {
      const reply = args[0];
      if (
        event === "message" &&
        !terminated &&
        target?.worker === this &&
        isRecord(reply) &&
        reply.id === target.id &&
        reply.ok === true
      ) {
        terminated = this.terminate();
        return true;
      }
      return originalEmit.call(this, event, ...args);
    });
    try {
      const failure = await setUserProfileAuthLinkAsync({
        profileId: owner,
        provider: "synthetic",
        authProfileId: "synthetic:lost-reply",
        ...authority,
      }).catch((error: unknown) => error);
      expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
      expect(terminated).toBeDefined();
      await terminated;
      expect(attempts).toBe(1);
      expect(await listUserProfileAuthLinksAsync(owner)).toMatchObject([
        { provider: "synthetic", authProfileId: "synthetic:lost-reply" },
      ]);
      expect(attempts).toBe(1);
    } finally {
      await terminated;
      posted.mockRestore();
      emitted.mockRestore();
    }
  }));
