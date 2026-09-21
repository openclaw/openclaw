import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { deferCanonicalSessionValidation } from "../config/sessions/session-canonical-validation-deferral.js";
import {
  authorizeGatewayRequestPreDispatch,
  createRequestGatewayMethodRegistry,
} from "./server-methods.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { withPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

const certifyReadiness = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../config/sessions/session-canonical-validation-readiness.js", () => ({
  certifySessionCanonicalValidationPending: certifyReadiness,
}));

afterEach(() => {
  vi.restoreAllMocks();
  certifyReadiness.mockReset();
});

const cfg = { agents: { entries: { main: {} } } };
const query = { agentId: "main", key: "agent:main:dashboard:incognito-prepared" };

function describeFixture() {
  const projection = createSessionRowProjectionFixture({ cfg, store: {} });
  projection.withPreparedExactRows = (queries, consume) =>
    withPreparedSessionRows(projection, () => true, queries, consume);
  const context = bindSessionRowProjection(requestContext(cfg), () => projection);
  const client = sharingPolicyClient({ scopes: ["operator.admin"] });
  const request = {
    method: "sessions.describe",
    requestParams: { key: query.key },
    client,
    context,
    methodRegistry: createRequestGatewayMethodRegistry(),
  };
  return { projection, context, client, request };
}

it("preserves the admin dispatch shortcut without preparing private rows", async () => {
  const { projection, request } = describeFixture();
  const prepare = vi.spyOn(projection, "withPreparedExactRows");
  Object.defineProperty(projection, "state", {
    get: () => {
      throw new Error("unexpected projection read before handler validation");
    },
  });
  await expect(authorizeGatewayRequestPreDispatch(request)).resolves.toEqual({ error: null });
  expect(prepare).not.toHaveBeenCalled();
});

it("rechecks dispatch scopes after canonical description readiness", async () => {
  const { projection, client, request } = describeFixture();
  client.connect.scopes = ["operator.read"];
  const database = { agentId: "main", path: "/synthetic/parent.sqlite" };
  vi.spyOn(projection, "withPreparedExactRows").mockResolvedValueOnce({
    kind: "pending",
    database,
  });
  certifyReadiness.mockImplementationOnce(async () => {
    client.connect.scopes = [];
  });
  await expect(authorizeGatewayRequestPreDispatch(request)).resolves.toMatchObject({
    error: { code: "FORBIDDEN", details: { code: "MISSING_SCOPE" } },
  });
  expect(certifyReadiness).toHaveBeenCalledExactlyOnceWith(database);
});

it("rechecks private access before responding after canonical description readiness", async () => {
  const { projection, context, client } = describeFixture();
  const database = { agentId: "main", path: "/synthetic/parent.sqlite" };
  vi.spyOn(projection, "withPreparedExactRows").mockResolvedValueOnce({
    kind: "pending",
    database,
  });
  const describe = vi.spyOn(projection, "describe");
  certifyReadiness.mockImplementationOnce(async () => {
    client.connect.scopes = ["operator.read"];
    client.authenticatedUserProfile = {
      profileId: "identified-viewer",
      displayName: "Viewer",
      hasAvatar: false,
      updatedAt: 1,
    };
  });
  const respond = vi.fn();
  await sessionByKeyReadHandlers["sessions.describe"]!({
    req: { type: "req", id: "private-description", method: "sessions.describe" },
    params: { key: query.key },
    context,
    client,
    respond,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
    code: "INVALID_REQUEST",
    message: `Incognito session "${query.key}" was not found.`,
  });
  expect(describe).not.toHaveBeenCalled();
  expect(certifyReadiness).toHaveBeenCalledExactlyOnceWith(database);
});

it("prepares an exact private read without consulting bulk readiness", async () => {
  const owner = createSessionRowProjectionFixture({ cfg, store: {} });
  Object.defineProperty(owner, "needsMaterialization", {
    get: () => {
      throw new Error("keyed reads must not depend on bulk state");
    },
  });
  const ready = vi.spyOn(owner, "ensureMaterialized").mockImplementation(() => {
    throw new Error("keyed reads must not join bulk readiness");
  });
  const queries = vi.fn(() => [query]);
  const describe = vi.spyOn(owner, "describe");
  const consume = vi.fn((read: SessionRowReadView) => read.describe(query));
  await expect(withPreparedSessionRows(owner, () => true, queries, consume)).resolves.toEqual({
    kind: "complete",
    value: undefined,
  });
  expect(ready).not.toHaveBeenCalled();
  expect(describe).toHaveBeenCalledExactlyOnceWith(query);
  expect(consume).toHaveBeenCalledOnce();
});

it("refuses a disposed projection before selecting or consuming rows", async () => {
  const owner = createSessionRowProjectionFixture({ cfg, store: {} });
  const queries = vi.fn(() => [query]);
  const consume = vi.fn();
  await expect(withPreparedSessionRows(owner, () => false, queries, consume)).rejects.toThrow(
    "no longer active",
  );
  expect(queries).not.toHaveBeenCalled();
  expect(consume).not.toHaveBeenCalled();
});

it("captures refreshed metadata after preparation without rereading the state getter during consumption", async () => {
  const owner = createSessionRowProjectionFixture({ cfg, store: {} });
  const initial = owner.state;
  let current = initial;
  const state = vi.fn(() => current);
  Object.defineProperty(owner, "state", { get: state });
  vi.spyOn(owner, "describe").mockImplementation(() => {
    current = {
      ...initial,
      rowContext: {
        ...initial.rowContext,
        configuredDefaultModelByAgent: new Map([["main", { provider: "fixture", model: "fresh" }]]),
      },
    };
    return undefined;
  });
  await withPreparedSessionRows(
    owner,
    () => true,
    () => [query],
    (read) => {
      state.mockClear();
      expect(read.state.rowContext.configuredDefaultModelByAgent.get("main")).toEqual({
        provider: "fixture",
        model: "fresh",
      });
      expect(read.describe(query)).toBeUndefined();
      expect(state).not.toHaveBeenCalled();
    },
  );
});

it("returns canonical readiness from private preparation without entering the consumer", async () => {
  const owner = createSessionRowProjectionFixture({ cfg, store: {} });
  const database = new DatabaseSync(":memory:");
  // The signal only needs a locator; this fixture never opens the named file.
  vi.spyOn(database, "location").mockReturnValue("/synthetic/parent.sqlite");
  vi.spyOn(owner, "describe").mockImplementation(() => {
    deferCanonicalSessionValidation({ agentId: "main", db: database });
    return undefined;
  });
  const consume = vi.fn();
  try {
    await expect(
      withPreparedSessionRows(
        owner,
        () => true,
        () => [query],
        consume,
      ),
    ).resolves.toEqual({
      kind: "pending",
      database: { agentId: "main", path: "/synthetic/parent.sqlite" },
    });
    expect(consume).not.toHaveBeenCalled();
  } finally {
    database.close();
  }
});
