import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveEffectiveAgentDir } from "../agents/agent-scope-config.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { resolveModelSelectionFromDirective } from "../auto-reply/reply/directive-handling.model-selection.js";
import { parseInlineSessionDirectives } from "../auto-reply/reply/directive-handling.parse.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerRequest,
} from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as providerAuth from "../plugins/provider-auth-method.js";
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
  connectUserModelAccount,
  listUserProfileAuthLinks,
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
import {
  ModelAccountConnectAuthorityError,
  ModelAccountConnectInputError,
} from "./model-account-connect-errors.js";
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
vi.mock("../plugins/personal-account-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/personal-account-auth.js")>()),
  listPersonalAccountAuthChoices: () => [],
  resolvePersonalAccountAuthMethod: resolveMethod,
}));

afterEach(() => vi.restoreAllMocks());

const credential: AuthProfileCredential = {
  type: "token",
  provider: "synthetic",
  token: "synthetic-private-account-token",
};
const authority = { assertCurrent() {} };
const accountOwner = (email: string) => ({
  owner: ensureProfileForEmail(email).id,
  ...authority,
});
const tokenCredential = (token: string) => ({
  type: "token" as const,
  provider: "synthetic",
  token,
});
const linked = (authProfileId: string) => ({ links: [{ provider: "synthetic", authProfileId }] });
function withService(
  run: (service: ReturnType<typeof createModelAccountConnectService>) => Promise<void>,
  onChanged?: () => void,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    const service = createModelAccountConnectService({ getConfig: () => ({}), onChanged });
    try {
      await run(service);
    } finally {
      await service.stop();
    }
  });
}

function observeWizardSettlement(signal: AbortSignal) {
  let settled = createDeferredCore();
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted Wizard remains the receiver.
  const cancel = WizardSession.prototype.cancel;
  const observer = vi.spyOn(WizardSession.prototype, "cancel").mockImplementation(function (
    this: WizardSession,
  ) {
    settled.resolve(this.whenSettled());
    return cancel.call(this);
  });
  return {
    reset: () => {
      settled = createDeferredCore();
    },
    wait: () => withinTest(settled.promise, signal),
    checkpoint: (gate: Promise<void>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, settled.promise, message), signal),
    [Symbol.dispose]: () => observer.mockRestore(),
  };
}
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
function createPinResolver() {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        modelPolicy: { allow: ["synthetic/probe"] },
        models: { "synthetic/probe": { alias: "pin-test" } },
      },
    },
  };
  const agentDir = resolveEffectiveAgentDir(cfg, "main");
  const modelPolicy = createModelVisibilityPolicy({
    cfg,
    catalog: [],
    defaultProvider: "synthetic",
    defaultModel: "probe",
  });
  return (rawProfile: string, requesterProfileId: string) =>
    resolveModelSelectionFromDirective({
      directives: parseInlineSessionDirectives(`/model pin-test@${rawProfile}`),
      cfg,
      agentDir,
      modelPolicy,
      defaultProvider: "synthetic",
      defaultModel: "probe",
      aliasIndex: modelPolicy.selectionAliasIndex,
      allowedModelKeys: modelPolicy.allowedKeys,
      requesterProfileId,
    });
}
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

it("keeps synchronous account methods owner-authorized and immediately persisted", async () =>
  withService(async (service) => {
    const { owner } = accountOwner("compat-owner@example.test");
    const other = accountOwner("compat-other@example.test");
    let live = true;
    const action = {
      owner,
      assertCurrent() {
        if (!live) {
          throw new ModelAccountConnectAuthorityError();
        }
      },
    };
    const compatCredential = tokenCredential("synthetic-compat-token");
    const connect = () =>
      connectUserModelAccount({
        ownerProfileId: owner,
        credential: compatCredential,
        assertCurrent() {},
      }).authProfileId;
    const first = connect();
    const second = connect();
    expect(service.listLinks(action)).toMatchObject(linked(second));
    expect(service.unlink(action, "synthetic")).toEqual({ links: [] });
    expect(listUserProfileAuthLinks(owner)).toEqual([]);
    expect(service.link(action, first)).toMatchObject(linked(first));
    expect(listUserProfileAuthLinks(owner)).toMatchObject([{ authProfileId: first }]);
    expect(service.select(action, second)).toMatchObject(linked(second));
    expect(listUserProfileAuthLinks(owner)).toMatchObject([{ authProfileId: second }]);
    const inventory = service.list(action);
    expect(inventory).toMatchObject({
      profileId: owner,
      accounts: expect.arrayContaining([
        expect.objectContaining({ authProfileId: first, selected: false }),
        expect.objectContaining({ authProfileId: second, selected: true }),
      ]),
      links: [{ provider: "synthetic", authProfileId: second }],
    });
    expect(JSON.stringify(inventory)).not.toContain(compatCredential.token);
    expect(readUserModelAuthProfile(first)?.credential).toEqual(compatCredential);
    expect(service.list(other)).toEqual({ profileId: other.owner, accounts: [], links: [] });
    expect(() => service.link(other, first)).toThrow(ModelAccountConnectInputError);
    expect(() => service.select(other, first)).toThrow(ModelAccountConnectInputError);
    expect(listUserProfileAuthLinks(other.owner)).toEqual([]);
    expect(service.status(action, "missing-connect")).toEqual({ status: "expired" });
    expect(service.cancel(action, "missing-connect")).toEqual({ status: "expired" });

    live = false;
    for (const invoke of [
      () => service.listLinks(action),
      () => service.link(action, first),
      () => service.unlink(action, "synthetic"),
      () => service.list(action),
      () => service.select(action, first),
      () => service.status(action, "missing-connect"),
      () => service.cancel(action, "missing-connect"),
    ]) {
      expect(invoke).toThrow(ModelAccountConnectAuthorityError);
    }
    expect(listUserProfileAuthLinks(owner)).toMatchObject([{ authProfileId: second }]);
  }));

it("keeps synchronous sign-in states private to their owner", async ({ signal }) => {
  const connected = createDeferredCore();
  const signinToken = "synthetic-compat-signin-token";
  await withService(async (service) => {
    const action = accountOwner("compat-signin@example.test");
    const other = accountOwner("compat-stranger@example.test");
    let prompted = createDeferredCore();
    using settlement = observeWizardSettlement(signal);
    const method: ProviderAuthMethod = {
      id: "token",
      label: "Synthetic token",
      kind: "token",
      async run(context) {
        const answer = context.prompter.text({ message: "Synthetic token", sensitive: true });
        prompted.resolve();
        const token = await answer;
        return {
          profiles: [{ profileId: "ignored-shared-id", credential: tokenCredential(token) }],
        };
      },
    };
    resolveMethod.mockResolvedValue(method);
    const waitFor = (gate: Promise<void>) =>
      settlement.checkpoint(gate, "Personal sign-in settled before reaching its client checkpoint");
    const startPending = async () => {
      prompted = createDeferredCore();
      settlement.reset();
      const flow = await service.start(action, "synthetic", "token");
      await waitFor(prompted.promise);
      const pending = service.status(action, flow.connectId);
      expect(pending).toMatchObject({
        status: "pending",
        step: { type: "text", sensitive: true },
      });
      assert(pending.status === "pending" && pending.step, "Expected pending sign-in step");
      return { ...flow, stepId: pending.step.id };
    };
    const cancelled = await startPending();
    expect(service.status(other, cancelled.connectId)).toEqual({ status: "expired" });
    expect(service.cancel(other, cancelled.connectId)).toEqual({ status: "expired" });
    expect(service.status(action, cancelled.connectId)).toMatchObject({ status: "pending" });
    expect(service.cancel(action, cancelled.connectId)).toEqual({ status: "cancelled" });
    await settlement.wait();
    expect(service.status(action, cancelled.connectId)).toEqual({ status: "cancelled" });
    expect(listUserProfileAuthLinks(action.owner)).toEqual([]);

    const expired = await startPending();
    const clock = vi.spyOn(Date, "now").mockReturnValue(expired.expiresAtMs + 1);
    try {
      expect(service.status(action, expired.connectId)).toEqual({ status: "expired" });
      expect(service.cancel(action, expired.connectId)).toEqual({ status: "expired" });
    } finally {
      clock.mockRestore();
    }
    await settlement.wait();

    const successful = await startPending();
    await service.answer(action, successful.connectId, successful.stepId, signinToken);
    await waitFor(connected.promise);
    await settlement.wait();
    const result = service.status(action, successful.connectId);
    expect(result).toMatchObject({
      status: "connected",
      authProfileId: expect.any(String),
      links: [{ provider: "synthetic" }],
    });
    assert(result.status === "connected", "Expected connected account result");
    expect(readUserModelAuthProfile(result.authProfileId)?.credential).toEqual(
      tokenCredential(signinToken),
    );
    expect(service.unlink(action, "synthetic")).toEqual({ links: [] });
    const replay = { status: "connected", authProfileId: result.authProfileId, links: [] };
    expect(service.status(action, successful.connectId)).toEqual(replay);
    expect(service.cancel(action, successful.connectId)).toEqual(replay);
    expect(service.status(other, successful.connectId)).toEqual({ status: "expired" });
    expect(JSON.stringify(result)).not.toContain(signinToken);
  }, connected.resolve);
});

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
    const resolvePin = createPinResolver();
    const { authProfileId } = await connectAccount(owner);
    expect((await resolvePin(authProfileId, owner)).profileOverride).toBe(authProfileId);
    const foreign = new DatabaseSync(resolveOpenClawStateSqlitePath());
    try {
      foreign
        .prepare(
          "DELETE FROM secret_store_entries WHERE scope_kind = 'identity' AND scope_id = ? AND name = ?",
        )
        .run(owner, `model-account:${authProfileId}`);
      expect(await resolvePin(authProfileId, owner)).toMatchObject({
        errorText: expect.stringContaining("signed-in profile"),
      });
    } finally {
      foreign.close();
    }
  }));

it("prepares and validates personal pins without caller SQL, retaining identity authority", () =>
  withAccount("pin-owner@example.test", async (owner) => {
    const resolvePin = createPinResolver();
    const successor = ensureProfileForEmail("pin-successor@example.test").id;
    const { authProfileId } = await connectAccount(owner);
    const selected = await withoutSql(async () => {
      const pin = await resolvePin(authProfileId, owner);
      expect(pin.profileOverride).toBe(authProfileId);
      expect(pin.validateAuthProfileSelection?.()).toBeUndefined();
      expect(await resolvePin(authProfileId, successor)).toMatchObject({
        errorText: expect.stringContaining("signed-in profile"),
      });
      return pin;
    });
    await clearUserProfileAuthLinkAsync({
      profileId: owner,
      provider: credential.provider,
      ...authority,
    });
    expect(selected.validateAuthProfileSelection?.()).toBeUndefined();
    linkEmail("pin-owner@example.test", successor);
    await withoutSql(() => {
      expect(selected.validateAuthProfileSelection?.()).toContain("signed-in profile");
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
    const settlement = observeWizardSettlement(signal);
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
    const authMethod: ProviderAuthMethod = {
      id: "token",
      label: "Synthetic token",
      kind: "token",
      run: async () => ({ profiles: [] }),
    };
    resolveMethod.mockResolvedValue(authMethod);
    vi.spyOn(providerAuth, "runProviderPluginAuthMethodUnpersisted").mockResolvedValue({
      profiles: [{ profileId: "ignored-shared-id", credential }],
    });
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
      await settlement.checkpoint(
        committed.promise,
        "Personal account sign-in settled before committing",
      );
      expect(await rpc("users.authConnect.cancel", { connectId: started.connectId })).toEqual({
        status: "cancelled",
      });
      deliverCommit.resolve();
      await settlement.checkpoint(
        changed.promise,
        "Personal account sign-in settled without publishing a connected account",
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
      settlement[Symbol.dispose]();
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
      using _ = observeAccountAdmission((stage) => {
        observed.push(stage);
        if (stage === refusalStage) {
          live = false;
        }
      });
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
    }),
);

it.each(["credential", "selection"] as const)(
  "compares before BEGIN and rereads %s account rows inside the transaction",
  (race) =>
    withAccount("replacement-account@example.test", async (owner) => {
      const first = await connectAccount(owner);
      const order: string[] = [];
      using _ = observeAccountAdmission((stage) => order.push(stage));
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

it("leaves the writer free while the host decides account admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("contention@example.test").id;
    using contention = probe.writerLock(resolveOpenClawStateSqlitePath());
    probe.admission(workerAdmission, (request, grant, admit) => {
      if (isRecord(request.facts) && request.facts.kind === "model-account-links") {
        contention.observe(request.stage);
      }
      admit(request, grant);
    });
    const { authProfileId } = await connectAccount(owner);
    expect(contention.observed).toEqual(["transaction:free", "commit:held"]);
    expect(readUserModelAuthProfile(authProfileId)?.credential).toEqual(credential);
    expect((await listUserModelAccountsAsync({ profileId: owner })).accounts).toContainEqual(
      expect.objectContaining({ authProfileId }),
    );
  });
});
