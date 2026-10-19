import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.js";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import {
  createStatusCommandOverviewRowsParams,
  createStatusScanResultFixture,
} from "./status.test-support.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn() }));

// mock-isolation: These tests own status projection/target routing, not physical store inspection.
vi.mock("../infra/database-engine/admitted-diagnostics.js", () => ({
  describeAdmittedDatabaseStores: mocks.describe,
}));

// mock-isolation: Database projection does not need Gateway, service-manager, or usage probes.
vi.mock("./status-runtime-shared.js", () => ({
  resolveStatusRuntimeSnapshot: async () => ({}),
  resolveStatusUsageSummary: vi.fn(),
}));

// mock-isolation: Backup-store I/O is unrelated to admitted database diagnostics.
vi.mock("../state/backup-run-records.js", () => ({
  readBackupRunFreshness: async () => ({}),
}));

const store: DatabaseStoreDiagnostic = {
  family: "state",
  path: "/fixture/openclaw-state.sqlite",
  configured: { default: "postgres", override: null, effective: "postgres", fixedLocal: false },
  observed: "sqlite",
  mismatch: true,
  schema: { versioning: "versioned", version: 5, expectedVersion: null, pending: null },
  connectivity: "local",
  namespace: null,
  storeId: null,
  database: null,
  extensions: null,
  admittedExtensions: null,
  degraded: null,
  custody: "unverifiable",
  lease: "unverifiable",
  backup: null,
  legacyMigrations: { state: "unknown", pending: [] },
  issues: ["Configured PostgreSQL, observed SQLite."],
  nextSteps: ["Run openclaw doctor on the Gateway host to inspect physical stores."],
};

describe("status database diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    mocks.describe.mockReturnValue([store]);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("projects the same physical store facts in text and JSON", async () => {
    const config = { database: { engine: "postgres" as const } };
    const payload = await resolveStatusJsonOutput({
      scan: createStatusScanResultFixture({ cfg: config }),
      opts: createStatusGatewayProbeBudget(),
      includeSecurityAudit: false,
    });
    const params = createStatusCommandOverviewRowsParams();
    const surface = { ...params.surface, cfg: {}, databaseEngines: payload.databaseEngines };
    const rows = buildStatusCommandOverviewRows({ ...params, surface });
    expect(payload.databaseEngines.source).toBe("admitted");
    expect(payload.databaseEngines.families.find((family) => family.id === "state")).toMatchObject({
      default: "postgres",
      effective: "postgres",
    });
    expect(rows.find((row) => row.Item === "Database engines (configured)")?.Value).toContain(
      "state: default=postgres, override=inherit, effective=postgres",
    );
    expect({
      text: rows.find((row) => row.Item === "Database state")?.Value,
      stores: payload.databaseEngines.stores,
    }).toMatchSnapshot();
    expect(mocks.describe).toHaveBeenCalledTimes(1);
  });

  it.each(["remote", "url-override"])(
    "never substitutes local stores for %s targets",
    async (target) => {
      if (target === "url-override") {
        vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://gateway.example.invalid");
      }
      const result = await resolveStatusDatabaseEngines(
        target === "remote" ? { gateway: { mode: "remote" } } : {},
      );
      expect(result).toEqual({
        source: "unavailable",
        stores: [],
        reason:
          "Physical stores unknown: the selected Gateway has not supplied admitted database facts. Run openclaw doctor on the Gateway host.",
      });
      expect(mocks.describe).not.toHaveBeenCalled();
    },
  );

  it("uses the selected Gateway's admitted projection without reading local stores", async () => {
    const result = await resolveStatusDatabaseEngines({ gateway: { mode: "remote" } }, [store]);
    expect(result.source).toBe("admitted");
    expect(result.stores[0]?.path).toBe("/fixture/openclaw-state.sqlite");
    expect(mocks.describe).not.toHaveBeenCalled();
  });

  it("keeps unavailable admissions unknown and suppresses connection secrets", async () => {
    mocks.describe.mockImplementationOnce(() => {
      throw new Error("connect postgres://fixture:private@localhost/db");
    });
    const result = await resolveStatusDatabaseEngines({});
    expect(result).toEqual({
      source: "unavailable",
      stores: [],
      reason:
        "Physical stores unknown: admitted facts unavailable. Run openclaw doctor for recovery steps.",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
