import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostic-record.js";
import type { DatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics.js";
import type { describeDatabaseEngineSelection } from "../infra/database-engine/report.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import {
  createStatusCommandOverviewRowsParams,
  createStatusScanResultFixture,
} from "./status.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

type StatusDatabaseJson = {
  databaseEngines: Awaited<ReturnType<typeof resolveStatusDatabaseEngines>> & {
    families: ReturnType<typeof describeDatabaseEngineSelection>;
  };
};
const mocks = vi.hoisted(() => ({
  describe: vi.fn(),
  scanStatusJsonFast: vi.fn(),
}));
// mock-isolation: Project fixed facts without live Gateway, service, or backup I/O.
vi.mock("./status.scan.fast-json.js", () => ({ scanStatusJsonFast: mocks.scanStatusJsonFast }));
vi.mock("../infra/update-run-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-status.js")>()),
  readUpdateRunStatus: async () => ({}),
}));

// mock-isolation: project synthetic admitted store facts without opening host databases.
vi.mock("../infra/database-engine/admitted-diagnostics.js", () => ({
  describeAdmittedDatabaseStores: mocks.describe,
}));

// mock-isolation: shared runtime and usage probes must not inspect the operator Gateway.
vi.mock("./status-runtime-shared.js", () => ({
  resolveStatusRuntimeSnapshot: async () => ({}),
  resolveStatusUsageSummary: vi.fn(),
}));

// mock-isolation: backup freshness is unrelated and must not read host backup records.
vi.mock("../state/backup-run-records.js", () => ({
  readBackupRunFreshness: async () => ({}),
}));

const store: DatabaseStoreDiagnostic = {
  ...createDatabaseStoreDiagnostic({
    family: "state",
    path: "/fixture/openclaw-state.sqlite",
    configured: { default: "postgres", override: null, effective: "postgres", fixedLocal: false },
  }),
  observed: "sqlite",
  mismatch: true,
  schema: { versioning: "versioned", version: 5, expectedVersion: null, pending: null },
  connectivity: "local",
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
    const runtime = createTestRuntime();
    const config = { database: { engine: "postgres" as const } };
    mocks.scanStatusJsonFast.mockResolvedValueOnce(createStatusScanResultFixture({ cfg: config }));
    await runStatusJsonCommand({
      runtime,
      opts: createStatusGatewayProbeBudget(),
    });
    const payload: StatusDatabaseJson = JSON.parse(
      String(expectDefined(runtime.log.mock.lastCall, "status JSON output")[0]),
    );
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

  it.each(["remote", "url-override", "admitted", "failed"])(
    "preserves store authority and redaction for %s targets",
    async (target) => {
      if (target === "url-override") {
        vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://gateway.example.invalid");
      }
      if (target === "failed") {
        mocks.describe.mockImplementationOnce(() => {
          throw new Error("connect postgres://fixture:private@localhost/db");
        });
      }
      const result = await resolveStatusDatabaseEngines(
        target === "remote" || target === "admitted" ? { gateway: { mode: "remote" } } : {},
        target === "admitted" ? [store] : undefined,
      );
      expect(result).toEqual(
        target === "admitted"
          ? { source: "admitted", stores: [store] }
          : {
              source: "unavailable",
              stores: [],
              reason:
                target === "failed"
                  ? "Physical stores unknown: admitted facts unavailable. Run openclaw doctor for recovery steps."
                  : "Physical stores unknown: the selected Gateway has not supplied admitted database facts. Run openclaw doctor on the Gateway host.",
            },
      );
      expect(mocks.describe).toHaveBeenCalledTimes(target === "failed" ? 1 : 0);
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );
});
