import { DatabaseSync } from "node:sqlite";
import type { Compilable, QueryResult } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readApnsRegistrationFromDatabase,
  readApnsRegistrationsFromDatabase,
  type apnsRegistrationFromRow,
} from "./push-apns-store.js";

type RegistrationRow = Parameters<typeof apnsRegistrationFromRow>[0];

const queries = vi.hoisted(() => ({
  first:
    vi.fn<(db: DatabaseSync, query: Compilable<RegistrationRow>) => RegistrationRow | undefined>(),
  all: vi.fn<
    (db: DatabaseSync, query: Compilable<RegistrationRow>) => QueryResult<RegistrationRow>
  >(),
  forbidden: () => {
    throw new Error("APNs read kernel must not open state, pair devices, or write");
  },
}));

// Only an inert handle identity is needed; no native SQLite constructor runs.
vi.mock("node:sqlite", () => ({ DatabaseSync: function MockDatabase() {} }));
vi.mock("../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: queries.forbidden,
  runOpenClawStateWriteTransaction: queries.forbidden,
}));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: queries.forbidden,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: queries.forbidden,
}));
vi.mock("./device-pairing-store.js", () => ({
  loadPairedDevicePairingStoreRecordFromDatabase: queries.forbidden,
}));
vi.mock("./device-pairing.js", () => ({ resolveNodePairingGeneration: queries.forbidden }));
vi.mock("./push-apns-store-transaction.js", () => ({
  clearApnsRegistrationFromDatabase: queries.forbidden,
  nextApnsRegistrationVersion: queries.forbidden,
}));
vi.mock("./device-identity.js", () => ({
  loadOrCreateProcessDeviceIdentity: queries.forbidden,
  signDevicePayload: queries.forbidden,
}));
vi.mock("./kysely-sync.js", async () => {
  const { Kysely, SqliteDialect } = await import("kysely");
  const dialect = new SqliteDialect({
    database: async () => {
      throw new Error("APNs kernel tests compile queries but never execute a Kysely driver");
    },
  });
  return {
    getNodeSqliteKysely: <Database>() => new Kysely<Database>({ dialect }),
    executeSqliteQueryTakeFirstSync: queries.first,
    executeSqliteQuerySync: queries.all,
  };
});

const database = new DatabaseSync("inert-apns-kernel");
const token = "abcd1234".repeat(4);
function directRow(nodeId: string): RegistrationRow {
  return {
    node_id: nodeId,
    transport: "direct",
    token,
    relay_handle: null,
    send_grant: null,
    installation_id: null,
    relay_origin: null,
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    distribution: null,
    token_debug_suffix: null,
    updated_at_ms: 7,
  };
}
function relayRow(nodeId: string): RegistrationRow {
  return {
    ...directRow(nodeId),
    transport: "relay",
    token: null,
    relay_handle: "synthetic-relay",
    send_grant: "synthetic-send-grant",
    installation_id: "synthetic-installation",
    relay_origin: "https://ios-push-relay.openclaw.ai",
    environment: "production",
    distribution: "official",
    token_debug_suffix: "abcd1234",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  queries.all.mockReturnValue({ rows: [] });
});

describe("APNs registration read kernels", () => {
  it("decodes a single direct registration using the requested node identity", () => {
    queries.first.mockImplementation((_database, query) => {
      expect(query.compile().parameters).toEqual(["node-one"]);
      return directRow("node-one");
    });
    expect(readApnsRegistrationFromDatabase(database, "node-one")).toEqual({
      nodeId: "node-one",
      transport: "direct",
      token,
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      updatedAtMs: 7,
    });
  });

  it("returns null for a missing single registration", () => {
    queries.first.mockReturnValue(undefined);
    expect(readApnsRegistrationFromDatabase(database, "missing-node")).toBeNull();
  });

  it.each([500, 501])("looks up %i IDs in bounded chunks and decodes both transports", (count) => {
    const nodeIds = Array.from({ length: count }, (_, index) => `node-${index}`);
    const finalId = `node-${count - 1}`;
    const stored = new Map([
      ["node-0", directRow("node-0")],
      [finalId, relayRow(finalId)],
    ]);
    const bindings: unknown[][] = [];
    queries.all.mockImplementation((_database, query) => {
      const parameters = query.compile().parameters;
      bindings.push([...parameters]);
      return {
        rows: parameters.flatMap((nodeId) => {
          if (typeof nodeId !== "string") {
            throw new Error("Expected a bound node ID");
          }
          const row = stored.get(nodeId);
          return row ? [row] : [];
        }),
      };
    });

    const registrations = readApnsRegistrationsFromDatabase(database, nodeIds);
    expect(bindings).toEqual(count === 500 ? [nodeIds] : [nodeIds.slice(0, 500), [finalId]]);
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
    { name: "invalid", token: "not-a-token", message: "invalid APNs registration row" },
    {
      name: "non-canonical",
      token: token.toUpperCase(),
      message: "non-canonical APNs registration row",
    },
  ])(
    "rejects an $name first chunk before querying the next chunk",
    ({ token: storedToken, message }) => {
      const nodeIds = Array.from({ length: 501 }, (_, index) => `node-${index}`);
      queries.all.mockReturnValueOnce({
        rows: [directRow("node-0"), { ...directRow("node-1"), token: storedToken }],
      });
      queries.all.mockImplementationOnce(() => {
        throw new Error("The next chunk must not run before decoding the first chunk");
      });

      expect(() => readApnsRegistrationsFromDatabase(database, nodeIds)).toThrow(
        new Error(message),
      );
      expect(queries.all).toHaveBeenCalledTimes(1);
    },
  );

  it("does not query for an empty batch", () => {
    expect(readApnsRegistrationsFromDatabase(database, [])).toEqual(new Map());
    expect(queries.all).not.toHaveBeenCalled();
  });

  it("returns an empty map when every queried registration is missing", () => {
    queries.all.mockReturnValue({ rows: [] });
    expect(readApnsRegistrationsFromDatabase(database, ["missing-one", "missing-two"])).toEqual(
      new Map(),
    );
    expect(queries.all).toHaveBeenCalledTimes(1);
  });
});
