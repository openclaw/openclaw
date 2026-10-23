import { DatabaseSync } from "node:sqlite";
import type { Compilable, QueryResult } from "kysely";
import { beforeEach, expect, it, vi } from "vitest";
import {
  readApnsRegistrationsFromDatabase,
  type apnsRegistrationFromRow,
} from "./push-apns-store.js";

type RegistrationRow = Parameters<typeof apnsRegistrationFromRow>[0];

const queries = vi.hoisted(() => {
  const forbidden = () => {
    throw new Error("APNs read kernel must not open state, pair devices, or write");
  };
  return {
    all: vi.fn<
      (db: DatabaseSync, query: Compilable<RegistrationRow>) => QueryResult<RegistrationRow>
    >(),
    forbidden,
    forbid: (...names: string[]) => Object.fromEntries(names.map((name) => [name, forbidden])),
  };
});

// Only an inert handle identity is needed; no native SQLite constructor runs.
vi.mock("node:sqlite", () => ({ DatabaseSync: function MockDatabase() {} }));
// mock-isolation: Kernel reads must never open or write host state.
vi.mock("../state/openclaw-state-db.js", () =>
  queries.forbid("openOpenClawStateDatabase", "runOpenClawStateWriteTransaction"),
);
// mock-isolation: Kernel reads must not capture host state ownership.
vi.mock("../state/openclaw-state-worker-context.js", () =>
  queries.forbid("captureOpenClawStateWorkerContext"),
);
// mock-isolation: Query compilation must not dispatch a real state worker.
vi.mock("../state/openclaw-state-worker-store.js", () =>
  queries.forbid("executeOpenClawStateWorker"),
);
vi.mock("./kysely-sync.js", async () => {
  const { Kysely, SqliteDialect } = await import("kysely");
  const dialect = new SqliteDialect({
    database: async () => {
      throw new Error("APNs kernel tests compile queries but never execute a Kysely driver");
    },
  });
  return {
    getNodeSqliteKysely: <Database>() => new Kysely<Database>({ dialect }),
    executeSqliteQueryTakeFirstSync: queries.forbidden,
    executeSqliteQuerySync: queries.all,
  };
});

const database = new DatabaseSync("inert-apns-kernel");
const token = "abcd1234".repeat(4);
function registrationRow(nodeId: string, relay = false): RegistrationRow {
  return {
    node_id: nodeId,
    transport: relay ? "relay" : "direct",
    token: relay ? null : token,
    relay_handle: relay ? "synthetic-relay" : null,
    send_grant: relay ? "synthetic-send-grant" : null,
    installation_id: relay ? "synthetic-installation" : null,
    relay_origin: relay ? "https://ios-push-relay.openclaw.ai" : null,
    topic: "ai.openclaw.ios",
    environment: relay ? "production" : "sandbox",
    distribution: relay ? "official" : null,
    token_debug_suffix: relay ? "abcd1234" : null,
    updated_at_ms: 7,
  };
}

beforeEach(() => vi.resetAllMocks());

it("looks up IDs in bounded chunks and decodes both transports", () => {
  const nodeIds = Array.from({ length: 501 }, (_, index) => `node-${index}`);
  const finalId = "node-500";
  const stored = [registrationRow("node-0"), registrationRow(finalId, true)];
  const bindings: unknown[][] = [];
  queries.all.mockImplementation((_database, query) => {
    const parameters = query.compile().parameters;
    bindings.push([...parameters]);
    return {
      rows: stored.filter((row) => parameters.includes(row.node_id)),
    };
  });

  const registrations = readApnsRegistrationsFromDatabase(database, nodeIds);
  expect(bindings).toEqual([nodeIds.slice(0, 500), [finalId]]);
  expect(registrations.size).toBe(2);
  expect(registrations.get("node-0")).toEqual({
    nodeId: "node-0",
    transport: "direct",
    token,
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    updatedAtMs: 7,
  });
  expect(registrations.get(finalId)).toEqual({
    nodeId: finalId,
    transport: "relay",
    relayHandle: "synthetic-relay",
    sendGrant: "synthetic-send-grant",
    installationId: "synthetic-installation",
    relayOrigin: "https://ios-push-relay.openclaw.ai",
    topic: "ai.openclaw.ios",
    environment: "production",
    distribution: "official",
    tokenDebugSuffix: "abcd1234",
    updatedAtMs: 7,
  });
  expect(registrations.has("node-1")).toBe(false);
});

it.each([
  ["invalid", "not-a-token"],
  ["non-canonical", token.toUpperCase()],
])("rejects an %s first chunk before querying the next chunk", (name, storedToken) => {
  const nodeIds = Array.from({ length: 501 }, (_, index) => `node-${index}`);
  queries.all.mockReturnValueOnce({
    rows: [registrationRow("node-0"), { ...registrationRow("node-1"), token: storedToken }],
  });
  queries.all.mockImplementationOnce(() => {
    throw new Error("The next chunk must not run before decoding the first chunk");
  });

  expect(() => readApnsRegistrationsFromDatabase(database, nodeIds)).toThrow(
    new Error(`${name} APNs registration row`),
  );
  expect(queries.all).toHaveBeenCalledTimes(1);
});
