import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerRequest,
} from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  connectUserModelAccount,
  listUserModelAccounts,
  listUserProfileAuthLinks,
  setUserProfileAuthLink,
} from "../state/user-model-account-operations.js";
import {
  readUserModelAuthProfile,
  setUserProfileAuthLink as setLinkSync,
  updateUserModelAuthProfile,
} from "../state/user-model-accounts.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { WizardSession } from "../wizard/session.js";
import { ModelAccountConnectAuthorityError } from "./model-account-connect-errors.js";
import { createModelAccountConnectService } from "./model-account-connect.js";
import type { RespondFn } from "./server-methods/types.js";
import { usersAuthConnectHandlers } from "./server-methods/users-auth-connect.js";
import { prepareUserModelAccountAction } from "./server-methods/users-model-account-access.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

const resolveMethod = vi.hoisted(() => vi.fn());
const runAuth = vi.hoisted(() => vi.fn());
vi.mock("../plugins/personal-account-auth.js", () => ({
  listPersonalAccountAuthChoices: () => [],
  resolvePersonalAccountAuthMethod: resolveMethod,
}));
vi.mock("../plugins/provider-auth-method.js", () => ({
  runProviderPluginAuthMethodUnpersisted: runAuth,
}));

afterEach(() => vi.restoreAllMocks());

const credential: AuthProfileCredential = {
  type: "token",
  provider: "synthetic",
  token: "synthetic-private-account-token",
};
const authority = { assertCurrent() {} };

function observeAccountAdmission(observer: (stage: "transaction" | "commit") => void) {
  const create = workerAdmission.createSqliteWorkerOperationAdmission;
  return vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      create((request, grant) => {
        if (
          isRecord(request.facts) &&
          request.facts.kind === "model-account-links" &&
          (request.stage === "transaction" || request.stage === "commit")
        ) {
          observer(request.stage);
        }
        admit(request, grant);
      }, attachment),
    );
}

it("serves personal account RPCs without caller-thread SQL or credentials", async ({ signal }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("worker-accounts@example.test").id;
    const client = createOperatorClient({
      profileId: owner,
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    const clients = new Set([client]);
    const context = createContext();
    context.getClientConnIds = (filter) =>
      new Set(
        [...clients]
          .filter((current) => !filter || filter(current))
          .flatMap((current) => (current.connId ? [current.connId] : [])),
      );
    const changed = createDeferredCore();
    const settled = createDeferredCore();
    const committed = createDeferredCore();
    const deliverCommit = createDeferredCore();
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      (workerContext, operation, options) =>
        runWorker(
          workerContext,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                const result = await scope.execute(command, executeOptions);
                if (command.type === "userProfiles.modelAccount.connect") {
                  committed.resolve();
                  await deliverCommit.promise;
                }
                return result;
              },
            }),
          options,
        ),
    );
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
      const handler = usersAuthConnectHandlers[method];
      if (!handler) {
        throw new Error(`Missing account handler: ${method}`);
      }
      const respond = vi.fn<RespondFn>();
      const input = { profileId: owner, ...params };
      await handler({
        req: { type: "req", id: "account-boundary", method, params: input },
        params: input,
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, payload, error] = respond.mock.calls[0] ?? [];
      expect(error).toBeUndefined();
      expect(ok).toBe(true);
      return payload;
    };
    const sql = observeHostDataSql();
    try {
      const calibration = new DatabaseSync(":memory:");
      try {
        calibration.prepare("SELECT 1").get();
        expect(sql.queries).toContain("SELECT 1");
      } finally {
        calibration.close();
      }
      sql.queries.length = 0;
      for (const call of sql.calls) {
        call.mockClear();
      }
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
      const link = { provider: "synthetic", authProfileId: connected.authProfileId };
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
      expect(
        await rpc("users.linkAuthProfile", { authProfileId: connected.authProfileId }),
      ).toMatchObject({ links: [link] });
      expect(
        await rpc("users.selectModelAccount", { authProfileId: connected.authProfileId }),
      ).toMatchObject({ links: [link] });
      expect(JSON.stringify(await rpc("users.listModelAccounts"))).not.toContain(credential.token);
      expect(JSON.stringify(connected)).not.toContain(credential.token);

      const action = await prepareUserModelAccountAction({ client, context }, owner);
      const staleList = service.listAsync(action);
      clients.clear();
      await expect(staleList).rejects.toBeInstanceOf(ModelAccountConnectAuthorityError);
      clients.add(client);
      const staleStatus = service.statusAsync(action, started.connectId);
      clients.clear();
      await expect(staleStatus).rejects.toBeInstanceOf(ModelAccountConnectAuthorityError);
      expect(sql.queries).toEqual([]);
      for (const call of sql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      deliverCommit.resolve();
      sql.restore();
      cancellation.mockRestore();
      await service.stop();
    }
  });
});

it.each([
  { stage: "transaction", allowed: false },
  { stage: "commit", allowed: false },
  { stage: "transaction", allowed: true },
] as const)(
  "uses the stored role when policy enables at $stage (allowed: $allowed), without grant SQL",
  async ({ stage, allowed }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("grant-role@example.test").id;
      setUserProfileRole(owner, "member");
      const first = await connectUserModelAccount({
        ownerProfileId: owner,
        credential,
        ...authority,
      });
      const second = await connectUserModelAccount({
        ownerProfileId: owner,
        credential,
        ...authority,
      });
      const client = createOperatorClient({ profileId: owner, scopes: ["operator.write"] });
      let cfg: OpenClawConfig = {};
      const context = createContext();
      context.getRuntimeConfig = () => cfg;
      context.getClientConnIds = (filter) =>
        new Set(client.connId && (!filter || filter(client)) ? [client.connId] : []);
      const service = createModelAccountConnectService({ getConfig: () => cfg });
      context.modelAccountConnectService = service;
      const enabled: OpenClawConfig = {
        gateway: {
          roles: {
            default: "fallback",
            definitions: {
              member: {
                sessions: { others: "none" },
                agents: [],
                scopes: allowed ? ["operator.write"] : [],
              },
              fallback: {
                sessions: { others: "none" },
                agents: [],
                scopes: allowed ? [] : ["operator.write"],
              },
            },
          },
        },
      };
      let inGrant = false;
      const grantSql: string[] = [];
      const sql = observeHostDataSql((query) => {
        if (inGrant) {
          grantSql.push(query);
        }
      });
      const stages: string[] = [];
      const create = workerAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          create((request, grant) => {
            if (!isRecord(request.facts) || request.facts.kind !== "model-account-links") {
              admit(request, grant);
              return;
            }
            stages.push(request.stage);
            if (request.stage === stage) {
              cfg = enabled;
            }
            inGrant = true;
            try {
              admit(request, grant);
            } finally {
              inGrant = false;
            }
          }, attachment),
        );
      try {
        const calibration = new DatabaseSync(":memory:");
        try {
          inGrant = true;
          calibration.prepare("SELECT 1").get();
          expect(grantSql).toContain("SELECT 1");
        } finally {
          inGrant = false;
          calibration.close();
        }
        grantSql.length = 0;
        const respond = vi.fn<RespondFn>();
        const handler = usersAuthConnectHandlers["users.selectModelAccount"];
        if (!handler) {
          throw new Error("Missing account selection handler");
        }
        const params = { profileId: owner, authProfileId: first.authProfileId };
        await handler({
          req: { type: "req", id: "grant-role", method: "users.selectModelAccount", params },
          params,
          client,
          context,
          respond,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledTimes(1);
        if (allowed) {
          expect(respond).toHaveBeenCalledWith(true, {
            links: expect.arrayContaining([
              expect.objectContaining({ authProfileId: first.authProfileId }),
            ]),
          });
        } else {
          // The real RPC mapper recognizes the authority error after worker transport.
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "FORBIDDEN" }),
          );
        }
        expect(stages).toEqual(
          stage === "transaction" && !allowed ? ["transaction"] : ["transaction", "commit"],
        );
        expect(grantSql).toEqual([]);
        expect(await listUserProfileAuthLinks(owner)).toMatchObject([
          { authProfileId: allowed ? first.authProfileId : second.authProfileId },
        ]);
      } finally {
        admission.mockRestore();
        sql.restore();
        await service.stop();
      }
    });
  },
);

it.each(["transaction", "commit"] as const)(
  "refuses revoked %s authority without committing either credential or link",
  async (refusalStage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("refused-account@example.test").id;
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
          connectUserModelAccount({
            ownerProfileId: owner,
            credential,
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
        expect(await listUserModelAccounts({ profileId: owner })).toEqual({ accounts: [] });
        expect(await listUserProfileAuthLinks(owner)).toEqual([]);
      } finally {
        admission.mockRestore();
      }
    });
  },
);

it.each(["unchanged", "credential", "selection"] as const)(
  "compares before BEGIN and rereads %s account rows inside the transaction",
  async (race) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("replacement-account@example.test").id;
      const first = await connectUserModelAccount({
        ownerProfileId: owner,
        credential,
        ...authority,
      });
      const order: string[] = [];
      const admission = observeAccountAdmission((stage) => order.push(stage));
      try {
        const result = await connectUserModelAccount({
          ownerProfileId: owner,
          credential: { ...credential, token: "synthetic-reconnected-token" },
          ...authority,
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
        if (race === "unchanged") {
          expect(result.authProfileId).toBe(first.authProfileId);
        } else {
          expect(result.authProfileId).not.toBe(first.authProfileId);
          expect(readUserModelAuthProfile(first.authProfileId)?.credential).toEqual({
            ...credential,
            token: race === "credential" ? "synthetic-concurrent-refresh" : credential.token,
          });
        }
        expect((await listUserModelAccounts({ profileId: owner })).accounts).toHaveLength(
          race === "unchanged" ? 1 : 2,
        );
        expect(await listUserProfileAuthLinks(owner)).toMatchObject([
          { authProfileId: result.authProfileId },
        ]);
      } finally {
        admission.mockRestore();
      }
    });
  },
);

it("does not replay a committed account mutation whose worker reply is lost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("lost-account-reply@example.test").id;
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
      const failure = await setUserProfileAuthLink({
        profileId: owner,
        provider: "synthetic",
        authProfileId: "synthetic:lost-reply",
        ...authority,
      }).catch((error: unknown) => error);
      expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
      expect(terminated).toBeDefined();
      await terminated;
      expect(attempts).toBe(1);
      expect(await listUserProfileAuthLinks(owner)).toMatchObject([
        { provider: "synthetic", authProfileId: "synthetic:lost-reply" },
      ]);
      expect(attempts).toBe(1);
    } finally {
      await terminated;
      posted.mockRestore();
      emitted.mockRestore();
    }
  });
});
