// Plugin inspection must keep every shared-state descriptor read-only.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const sqliteMocks = vi.hoisted(() => ({
  openNodeSqliteDatabase: vi.fn(),
}));

vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  sqliteMocks.openNodeSqliteDatabase.mockImplementation(actual.openNodeSqliteDatabase);
  return {
    ...actual,
    openNodeSqliteDatabase: sqliteMocks.openNodeSqliteDatabase,
  };
});

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
}));

vi.mock("../plugins/status.js", () => ({
  buildAllPluginInspectReports: () => [],
  buildPluginDiagnosticsReport: vi.fn(),
  buildPluginInspectReport: vi.fn(),
  buildPluginSnapshotReport: () => ({ plugins: [], diagnostics: [] }),
  formatPluginCompatibilityNotice: vi.fn(),
}));

const { runPluginsInspectCommand } = await import("./plugins-inspect-command.js");

describe("plugins inspect shared-state access", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    sqliteMocks.openNodeSqliteDatabase.mockClear();
  });

  it("opens no writable shared-state descriptor for snapshot inspection", async () => {
    await withOpenClawTestState(
      { label: "plugins-inspect-readonly", layout: "state-only", scenario: "minimal" },
      async (state) => {
        openOpenClawStateDatabase({ env: state.env });
        closeOpenClawStateDatabaseForTest();
        sqliteMocks.openNodeSqliteDatabase.mockClear();

        await runPluginsInspectCommand(undefined, { all: true, json: true });

        expect(sqliteMocks.openNodeSqliteDatabase).toHaveBeenCalled();
        for (const [, options] of sqliteMocks.openNodeSqliteDatabase.mock.calls) {
          expect(options).toEqual(expect.objectContaining({ readOnly: true }));
        }
      },
    );
  });
});
