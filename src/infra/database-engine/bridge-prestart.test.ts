import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  publishSqliteDatabaseAdmission,
  publishSqliteDatabaseSchemaChange,
  retireSqliteDatabaseAdmissionForPath,
  withSqliteDatabaseAdmissionExchange,
} from "../sqlite-database-admission.js";
import { prepareAdmittedPostgresBridge } from "./bridge-prestart.js";
import type { PostgresPhysicalFacts } from "./physical-facts.js";
import type { DatabaseEngineSelection } from "./types.js";

const transport = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../postgres-sync/bridge-prestart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../postgres-sync/bridge-prestart.js")>()),
  preparePostgresBridge: transport.prepare,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const selection: DatabaseEngineSelection = {
  effectiveEngines: {
    state: "sqlite",
    agent: "sqlite",
    workboard: "sqlite",
    logbook: "sqlite",
    "team-reports": "postgres",
    quarantine: "sqlite",
    "managed-update": "sqlite",
    "package-activation": "sqlite",
  },
  postgres: { connection: "postgresql://fixture.invalid/db", schemaPrefix: "fixture" },
};
const facts: PostgresPhysicalFacts = {
  engine: "postgres",
  admissionId: "fixture-admission",
  store: "team_reports",
  namespace: "fixture_team_reports",
  storeId: "fixture-store",
  version: 1,
  capabilities: { serverMajor: 17, serverEncoding: "UTF8", clientEncoding: "UTF8" },
  catalog: [],
};
const physicalFactsKey = { name: "database.engine.schema", schemaDependent: true };

beforeEach(() => transport.prepare.mockReset());

function admittedAnchor() {
  const location = path.join(tempDirs.make("bridge-admission-"), "anchor.sqlite");
  const database = openNodeSqliteDatabase(location);
  return {
    location,
    database,
    [Symbol.dispose]() {
      database.close();
      retireSqliteDatabaseAdmissionForPath(location);
    },
  };
}

function withoutProbes<T>(operation: () => T): T {
  const rejectProbe = () => {
    throw new Error("Bridge preparation must use delivered facts without probing");
  };
  const open = vi.spyOn(fs, "openSync").mockImplementation(rejectProbe);
  const stat = vi.spyOn(fs, "statSync").mockImplementation(rejectProbe);
  const exchange = vi.fn(rejectProbe);
  try {
    const result = withSqliteDatabaseAdmissionExchange(exchange, operation);
    expect(open).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
    return result;
  } finally {
    open.mockRestore();
    stat.mockRestore();
  }
}

it("prepares the exact admitted identity for a selected store family without probing", () => {
  using anchor = admittedAnchor();
  publishSqliteDatabaseAdmission(anchor.database, physicalFactsKey, facts);
  const signal = new AbortController().signal;
  const prepared = {
    run: <T>(operation: () => T): T => operation(),
    [Symbol.asyncDispose]: async () => {},
  };
  transport.prepare.mockReturnValue(prepared);

  const result = withoutProbes(() =>
    prepareAdmittedPostgresBridge(anchor.location, selection, { reuse: true, signal }),
  );

  expect(result).toBe(prepared);
  expect(transport.prepare).toHaveBeenCalledExactlyOnceWith(
    {
      url: "postgresql://fixture.invalid/db",
      schema: "fixture_team_reports",
      storeId: "fixture-store",
      reuse: true,
    },
    signal,
  );
});

it.each(["missing-location", "missing-facts", "stale-facts", "sqlite-family"] as const)(
  "does no preparation or probing for %s",
  (condition) => {
    using anchor = admittedAnchor();
    if (condition !== "missing-facts") {
      publishSqliteDatabaseAdmission(anchor.database, physicalFactsKey, facts);
    }
    if (condition === "stale-facts") {
      publishSqliteDatabaseSchemaChange(anchor.database);
    }
    const location =
      condition === "missing-location" ? `${anchor.location}.missing` : anchor.location;
    const selected =
      condition === "sqlite-family"
        ? {
            ...selection,
            effectiveEngines: { ...selection.effectiveEngines, "team-reports": "sqlite" as const },
          }
        : selection;

    expect(withoutProbes(() => prepareAdmittedPostgresBridge(location, selected))).toBeUndefined();
    expect(transport.prepare).not.toHaveBeenCalled();
  },
);
