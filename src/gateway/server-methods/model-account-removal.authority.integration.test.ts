// Real-Gateway authority proof for users.removeModelAccount over the WebSocket
// transport: the trusted-proxy ingress binds each connection to its own person,
// roles govern scopes, and every request below travels the production dispatch
// path (connect handshake, validation, action preparation, state workers).
// Storage is seeded through the production state-layer writers; only the
// credential values are synthetic and never printed.
import { X509Certificate } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type {
  UsersListModelAccountsResult,
  UsersRemoveModelAccountResult,
  UsersSelfResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as userModelAccountOperations from "../../state/user-model-account-operations.js";
import { connectUserModelAccountAsync } from "../../state/user-model-account-operations.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getModelAccountRemoval } from "../model-account-connect.js";
import type { OperatorScope } from "../operator-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "../test-helpers.env.js";
import * as userModelAccountAccess from "./users-model-account-access.js";

const DOMAIN = "b1-authority.example.test";
const ORIGIN = "https://b1-control.example.test";
const PERSON_SCOPES: OperatorScope[] = ["operator.read", "operator.write"];
const PINNED_SESSION = "agent:main:b1-pinned";
const KEPT_SESSION = "agent:main:b1-kept";

type Person = "owner" | "admin" | "bystander";

const trace = (line: string) => {
  console.log(`[b1-removal-authority] ${line}`);
};

function personEmail(name: Person) {
  return `${name}@${DOMAIN}`;
}

/** Names and metadata only; credential values are never selected or printed. */
function readAccountRows(state: OpenClawTestState) {
  const database = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env), { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT name, scope_id, kind, deleted_at_ms FROM secret_store_entries" +
          " WHERE name LIKE 'model-account:%' ORDER BY scope_id, name",
      )
      .all() as Array<{
      name: string;
      scope_id: string;
      kind: string;
      deleted_at_ms: number | null;
    }>;
  } finally {
    database.close();
  }
}

/** The per-owner selection record holds profile IDs only; compare, never print. */
function readLinksRecords(state: OpenClawTestState) {
  const database = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env), { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT scope_id, value FROM secret_store_entries WHERE name = 'model-accounts'" +
          " ORDER BY scope_id",
      )
      .all() as Array<{ scope_id: string; value: string }>;
  } finally {
    database.close();
  }
}

function readSession(agentId: string, sessionKey: string) {
  return loadSessionEntryReadOnly({
    agentId,
    storePath: resolveDefaultSessionStorePath(agentId),
    sessionKey,
  });
}

async function connectPersonalAccount(
  ownerProfileId: string,
  provider: string,
  label: string,
): Promise<string> {
  const connected = await connectUserModelAccountAsync({
    ownerProfileId,
    credential: {
      type: "token",
      provider,
      token: `synthetic-b1-${label}-${ownerProfileId.slice(0, 8)}`,
      displayName: label,
    },
    assertCurrent() {},
  });
  return connected.authProfileId;
}

function seedPeople(): Record<Person, { id: string }> {
  const owner = ensureProfileForEmail(personEmail("owner"));
  const admin = ensureProfileForEmail(personEmail("admin"));
  const bystander = ensureProfileForEmail(personEmail("bystander"));
  setUserProfileRole(admin.id, "administrator");
  return { owner: { id: owner.id }, admin: { id: admin.id }, bystander: { id: bystander.id } };
}

async function seedOwnedAccounts(people: Record<Person, { id: string }>) {
  const removed = await connectPersonalAccount(people.owner.id, "b1-alpha", "removed");
  const kept = await connectPersonalAccount(people.owner.id, "b1-beta", "kept");
  const foreign = await connectPersonalAccount(people.bystander.id, "b1-alpha", "foreign");
  await replaceSessionEntry(
    {
      agentId: "main",
      storePath: resolveDefaultSessionStorePath("main"),
      sessionKey: PINNED_SESSION,
    },
    {
      sessionId: "b1-pinned",
      updatedAt: 17,
      providerOverride: "b1-alpha",
      modelOverride: "b1-old-model",
      authProfileOverride: removed,
      authProfileOverrideSource: "user",
      modelFallback: {
        source: "agent-patch",
        ts: 1,
        prevModel: "b1-old-model",
        prevProvider: "b1-alpha",
        prevAuthProfileOverride: removed,
      },
    },
  );
  await replaceSessionEntry(
    {
      agentId: "main",
      storePath: resolveDefaultSessionStorePath("main"),
      sessionKey: KEPT_SESSION,
    },
    { sessionId: "b1-kept", updatedAt: 18, authProfileOverride: kept },
  );
  return { removed, kept, foreign };
}

async function startAuthorityGateway(
  state: OpenClawTestState,
  people: Record<Person, { id: string }>,
) {
  const auth: GatewayAuthConfig = {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowUsers: (["owner", "admin", "bystander"] as const).map(personEmail),
      allowLoopback: true,
      deviceAutoApprove: { enabled: true, scopes: PERSON_SCOPES },
    },
    identityScopes: { [personEmail("admin")]: ["operator.admin"] },
  };
  const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
  const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
  const cfg = {
    agents: {
      entries: { main: {} },
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
    },
    plugins: { enabled: false, slots: { memory: "none" } },
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1", "::1"],
      controlUi: { allowedOrigins: [ORIGIN] },
      tls: { enabled: true, autoGenerate: false, certPath, keyPath },
      roles: {
        default: "member",
        definitions: {
          administrator: {
            agents: "*",
            sessions: { others: "write" },
            scopes: ["operator.admin"],
          },
          member: { agents: "*", sessions: { others: "write" }, scopes: PERSON_SCOPES },
          revoked: { agents: "*", sessions: { others: "none" }, scopes: ["operator.read"] },
        },
      },
    },
  } satisfies OpenClawConfig;
  const gateway = await startGatewayWithClient({
    cfg,
    configPath: state.configPath,
    auth,
    secure: true,
    tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    origin: ORIGIN,
    scopes: ["operator.admin"],
    edgeAuthHeaders: forwardedHeaders("admin"),
  });
  await gateway.server.startupSettled;
  const admin = gateway.client;
  const connectPerson = async (name: Person) => {
    const client = await connectGatewayClient({
      url: `wss://127.0.0.1:${gateway.port}`,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      origin: ORIGIN,
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
      scopes: PERSON_SCOPES,
      edgeAuthHeaders: forwardedHeaders(name),
      deviceIdentity: loadOrCreateDeviceIdentity({
        path: state.statePath("identities", name, "client", "credentials.sqlite"),
      }),
    });
    const self = await client.request<UsersSelfResult>("users.self", {});
    expect(self.profile.id).toBe(people[name].id);
    return client;
  };
  return { gateway, admin, connectPerson };
}

function forwardedHeaders(name: Person) {
  return {
    "x-forwarded-user": personEmail(name),
    "x-forwarded-proto": "https",
    "x-forwarded-for": "203.0.113.50",
  };
}

const settle = <T>(work: Promise<T>) =>
  work.then(
    (result) => ({ result, error: undefined as unknown }),
    (error: unknown) => ({ result: undefined as unknown, error }),
  );

function createMutationHold(cleanup: AsyncDisposableStack) {
  const reached = createDeferred();
  const release = createDeferred();
  cleanup.defer(() => release.resolve());
  cleanup.defer(() => reached.resolve());
  return {
    reached: reached.promise,
    release: release.promise,
    markReached: () => reached.resolve(),
    releaseNow: () => release.resolve(),
  };
}

async function createState(label: string) {
  return await createOpenClawTestState({
    label,
    env: {
      ...KERNEL_TEST_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    },
    prepareProfileCatalog: true,
  });
}

it(
  "an authorized owner removes only their own saved credential over the real transport",
  { timeout: 120_000 },
  async () => {
    const state = await createState("b1-removal-owner");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    const people = seedPeople();
    const accounts = await seedOwnedAccounts(people);
    const before = {
      rows: readAccountRows(state),
      links: readLinksRecords(state),
      pinned: readSession("main", PINNED_SESSION),
      kept: readSession("main", KEPT_SESSION),
    };
    expect(before.rows.map((row) => row.name).toSorted()).toEqual(
      [
        `model-account:${accounts.kept}`,
        `model-account:${accounts.foreign}`,
        `model-account:${accounts.removed}`,
      ].toSorted(),
    );
    const { gateway, connectPerson } = await startAuthorityGateway(state, people);
    cleanup.defer(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "b1 owner removal proof complete" });
    });
    const owner = await connectPerson("owner");
    cleanup.defer(() => disconnectGatewayClient(owner));
    const listed = await owner.request<UsersListModelAccountsResult>("users.listModelAccounts", {});
    expect(listed.accounts.map((account) => account.authProfileId).toSorted()).toEqual(
      [accounts.kept, accounts.removed].toSorted(),
    );
    trace(`owner transport list before: ${listed.accounts.length} accounts (values redacted)`);

    const removed = await owner.request<UsersRemoveModelAccountResult>("users.removeModelAccount", {
      authProfileId: accounts.removed,
    });
    expect(removed).toMatchObject({
      removed: true,
      authProfileId: accounts.removed,
      sessionCleanup: "complete",
      links: [{ provider: "b1-beta", authProfileId: accounts.kept }],
    });
    trace(`owner transport removal: removed=true sessionCleanup=${removed.sessionCleanup}`);

    const after = await owner.request<UsersListModelAccountsResult>("users.listModelAccounts", {});
    expect(after.accounts).toEqual([
      expect.objectContaining({
        authProfileId: accounts.kept,
        provider: "b1-beta",
        selected: true,
      }),
    ]);
    const rows = readAccountRows(state);
    expect(rows.map((row) => row.name).toSorted()).toEqual(
      [`model-account:${accounts.kept}`, `model-account:${accounts.foreign}`].toSorted(),
    );
    const ownerLinks = readLinksRecords(state).find(
      (record) => record.scope_id === people.owner.id,
    );
    const decodedLinks = JSON.parse(ownerLinks?.value ?? "{}") as {
      links?: Record<string, { authProfileId: string } | null>;
    };
    expect(decodedLinks.links?.["b1-alpha"]).toBeNull();
    expect(decodedLinks.links?.["b1-beta"]).toMatchObject({ authProfileId: accounts.kept });
    expect(
      readLinksRecords(state).filter((record) => record.scope_id === people.bystander.id),
    ).toEqual(before.links.filter((record) => record.scope_id === people.bystander.id));
    const pinned = readSession("main", PINNED_SESSION);
    expect(pinned).toMatchObject({
      updatedAt: 17,
      providerOverride: "b1-alpha",
      modelOverride: "b1-old-model",
      modelFallback: { prevModel: "b1-old-model" },
    });
    expect(pinned?.authProfileOverride).toBeUndefined();
    expect(pinned?.modelFallback?.prevAuthProfileOverride).toBeUndefined();
    const keptEntry = readSession("main", KEPT_SESSION);
    expect(keptEntry).toEqual(before.kept);
    trace(
      "storage after: removed credential row deleted; kept+foreign rows intact; pinned session" +
        " override and rollback pin cleared; kept session byte-identical",
    );
  },
);

it(
  "an administrator without ownership cannot remove another person's credential",
  { timeout: 120_000 },
  async () => {
    const state = await createState("b1-removal-admin");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    const people = seedPeople();
    const accounts = await seedOwnedAccounts(people);
    const before = {
      rows: readAccountRows(state),
      links: readLinksRecords(state),
      pinned: readSession("main", PINNED_SESSION),
    };
    const { gateway, admin, connectPerson } = await startAuthorityGateway(state, people);
    cleanup.defer(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "b1 admin denial proof complete" });
    });
    const owner = await connectPerson("owner");
    cleanup.defer(() => disconnectGatewayClient(owner));
    const self = await admin.request<UsersSelfResult>("users.self", {});
    expect(self.profile.id).toBe(people.admin.id);

    const denied = admin.request("users.removeModelAccount", {
      profileId: people.owner.id,
      authProfileId: accounts.removed,
    });
    await expect(denied).rejects.toMatchObject({ code: "FORBIDDEN" });
    trace("admin transport denial (explicit owner target): code=FORBIDDEN");

    const claimed = await settle(
      admin.request<UsersRemoveModelAccountResult>("users.removeModelAccount", {
        authProfileId: accounts.removed,
      }),
    );
    expect(claimed.error).toBeDefined();
    trace(`admin transport denial (claimed foreign id): rejected (${String(claimed.error)})`);

    expect(readAccountRows(state)).toEqual(before.rows);
    expect(readLinksRecords(state)).toEqual(before.links);
    expect(readSession("main", PINNED_SESSION)).toEqual(before.pinned);
    const listed = await owner.request<UsersListModelAccountsResult>("users.listModelAccounts", {});
    expect(listed.accounts.map((account) => account.authProfileId).toSorted()).toEqual(
      [accounts.kept, accounts.removed].toSorted(),
    );
    trace("storage after denials: unchanged rows, unchanged session pin");
  },
);

it.for(["revoked", "disconnected"] as const)(
  "authority lost during asynchronous preparation fences the removal write: %s",
  { timeout: 120_000 },
  async (mode, { signal }) => {
    const state = await createState(`b1-removal-fence-${mode}`);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    const people = seedPeople();
    const accounts = await seedOwnedAccounts(people);
    const before = {
      rows: readAccountRows(state),
      links: readLinksRecords(state),
      pinned: readSession("main", PINNED_SESSION),
      kept: readSession("main", KEPT_SESSION),
    };
    const { gateway, admin, connectPerson } = await startAuthorityGateway(state, people);
    cleanup.defer(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: `b1 ${mode} fence proof complete` });
    });
    const owner = await connectPerson("owner");
    const mutationHold = createMutationHold(cleanup);
    // Hold after admission, before the state worker deletes anything; the real
    // operation still runs once released, so a passing guard must not skip work.
    const real = userModelAccountOperations.removeUserModelAccountAsync;
    const operationSettled = createDeferred();
    const operationOutcome = createDeferred<{ error?: unknown }>();
    const hold = vi
      .spyOn(userModelAccountOperations, "removeUserModelAccountAsync")
      .mockImplementationOnce(async (...args: Parameters<typeof real>) => {
        mutationHold.markReached();
        await mutationHold.release;
        try {
          const result = await real(...args);
          operationOutcome.resolve({});
          return result;
        } catch (error) {
          operationOutcome.resolve({ error });
          throw error;
        } finally {
          // The client request can reject as soon as its socket closes. Wait for
          // the actual state-worker operation before asserting its final effect.
          operationSettled.resolve();
        }
      });
    try {
      const reply = owner.request<UsersRemoveModelAccountResult>("users.removeModelAccount", {
        authProfileId: accounts.removed,
      });
      void reply.catch(() => undefined);
      await withinTest(
        awaitGateBeforeSettlement(
          mutationHold.reached,
          reply,
          "removal settled before the preparation hold",
        ),
        signal,
      );
      if (mode === "revoked") {
        await admin.request("users.setRole", { profileId: people.owner.id, role: "revoked" });
        trace("revocation issued over transport: users.setRole owner -> revoked");
      } else {
        await disconnectGatewayClient(owner);
        trace("owner socket closed during preparation hold");
      }
      mutationHold.releaseNow();
      await withinTest(operationSettled.promise, signal);
      expect((await withinTest(operationOutcome.promise, signal)).error).toBeDefined();
      expect((await withinTest(settle(reply), signal)).error).toBeDefined();
      expect(readAccountRows(state)).toEqual(before.rows);
      expect(readLinksRecords(state)).toEqual(before.links);
      expect(readSession("main", PINNED_SESSION)).toEqual(before.pinned);
      expect(readSession("main", KEPT_SESSION)).toEqual(before.kept);
      trace(`storage after ${mode} fence: credential row, link row, and session pins unchanged`);
      const observer = await connectPerson("owner");
      cleanup.defer(() => disconnectGatewayClient(observer));
      const listed = await observer.request<UsersListModelAccountsResult>(
        "users.listModelAccounts",
        {},
      );
      expect(listed.accounts.map((account) => account.authProfileId).toSorted()).toEqual(
        [accounts.kept, accounts.removed].toSorted(),
      );
      trace(`fresh owner connection still lists both accounts after ${mode} fence`);
    } finally {
      hold.mockRestore();
    }
  },
);

it.for(["revoked", "disconnected"] as const)(
  "a committed deletion stands while post-commit session cleanup is fenced: %s",
  { timeout: 120_000 },
  async (mode, { signal }) => {
    const state = await createState(`b1-removal-postcommit-${mode}`);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    const people = seedPeople();
    const accounts = await seedOwnedAccounts(people);
    const before = {
      pinned: readSession("main", PINNED_SESSION),
      kept: readSession("main", KEPT_SESSION),
    };
    const { gateway, admin, connectPerson } = await startAuthorityGateway(state, people);
    cleanup.defer(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: `b1 ${mode} post-commit proof complete` });
    });
    const owner = await connectPerson("owner");
    const mutationHold = createMutationHold(cleanup);
    // Hold after the real state-worker removal has committed, before the
    // handler's post-commit authority recheck and session cleanup run.
    const real = userModelAccountOperations.removeUserModelAccountAsync;
    const serviceSettled = createDeferred();
    const realPrepare = userModelAccountAccess.prepareUserModelAccountAction;
    const prepare = vi
      .spyOn(userModelAccountAccess, "prepareUserModelAccountAction")
      .mockImplementationOnce(async (...args) => {
        const action = await realPrepare(...args);
        const service = args[0].context.modelAccountConnectService;
        if (!service) {
          throw new Error("Model-account service is unavailable in the test Gateway");
        }
        // Removal is Gateway-internal: patch the service-bound removal operation.
        const removal = getModelAccountRemoval(service);
        if (!removal) {
          throw new Error("Model-account removal operation is unavailable in the test Gateway");
        }
        const realRemove = removal.removeAsync.bind(removal);
        vi.spyOn(removal, "removeAsync").mockImplementationOnce(
          async (...removeArgs: Parameters<typeof realRemove>) => {
            try {
              return await realRemove(...removeArgs);
            } finally {
              // The client reply can reject as soon as its socket closes. Wait for
              // the full service operation, including its cleanup attempt, first.
              serviceSettled.resolve();
            }
          },
        );
        return action;
      });
    const hold = vi
      .spyOn(userModelAccountOperations, "removeUserModelAccountAsync")
      .mockImplementationOnce(async (...args: Parameters<typeof real>) => {
        const result = await real(...args);
        mutationHold.markReached();
        await mutationHold.release;
        return result;
      });
    try {
      const reply = owner.request<UsersRemoveModelAccountResult>("users.removeModelAccount", {
        authProfileId: accounts.removed,
      });
      void reply.catch(() => undefined);
      await withinTest(
        awaitGateBeforeSettlement(
          mutationHold.reached,
          reply,
          "removal settled before the post-commit hold",
        ),
        signal,
      );
      const rowsAtHold = readAccountRows(state);
      expect(rowsAtHold.map((row) => row.name).toSorted()).toEqual(
        [`model-account:${accounts.kept}`, `model-account:${accounts.foreign}`].toSorted(),
      );
      const linksAtHold = readLinksRecords(state);
      const ownerLinksAtHold = JSON.parse(
        linksAtHold.find((record) => record.scope_id === people.owner.id)?.value ?? "{}",
      ) as { links?: Record<string, { authProfileId: string } | null> };
      expect(ownerLinksAtHold.links?.["b1-alpha"]).toBeNull();
      expect(ownerLinksAtHold.links?.["b1-beta"]).toMatchObject({ authProfileId: accounts.kept });
      trace("deletion committed before authority loss (committed effect, no rollback claimed)");
      if (mode === "revoked") {
        await admin.request("users.setRole", { profileId: people.owner.id, role: "revoked" });
        trace("revocation issued over transport after commit: users.setRole owner -> revoked");
      } else {
        await disconnectGatewayClient(owner);
        trace("owner socket closed after commit");
      }
      mutationHold.releaseNow();
      await withinTest(serviceSettled.promise, signal);
      const outcome = await withinTest(settle(reply), signal);
      expect(outcome.error).toBeDefined();
      // The committed deletion stands; the subsequent session cleanup must not.
      expect(readAccountRows(state)).toEqual(rowsAtHold);
      expect(readLinksRecords(state)).toEqual(linksAtHold);
      const pinned = readSession("main", PINNED_SESSION);
      expect(pinned?.authProfileOverride).toBe(accounts.removed);
      expect(pinned?.modelFallback?.prevAuthProfileOverride).toBe(accounts.removed);
      expect(readSession("main", KEPT_SESSION)).toEqual(before.kept);
      trace(`post-commit ${mode}: credential row stays deleted; session pins stay untouched`);
    } finally {
      hold.mockRestore();
      prepare.mockRestore();
    }
  },
);
