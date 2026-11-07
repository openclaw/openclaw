import { beforeEach, expect, it, vi } from "vitest";
import { createUpdateRunRecordFixture } from "../../infra/update-run-record.test-support.js";
import { renderUpdateHistory, updateHistoryCommand } from "./history.js";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));

vi.mock("../../infra/update-run-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-reader.js")>()),
  listUpdateRuns: mocks.list,
  getUpdateRun: mocks.get,
}));

// Database-engine selection belongs to the update-command owner; history just reads
// through it. This mock keeps the command tests free of engine state.
vi.mock("./update-command-database-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-database-engine.js")>()),
  withUpdateDatabaseEngine: (_env: unknown, run: () => Promise<void>) => run(),
}));

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

function printed(out: ReturnType<typeof runtime>): string {
  return out.log.mock.calls.map(([line]) => String(line)).join("\n");
}

beforeEach(() => vi.clearAllMocks());

it("lists recorded runs with their ids, targets, and reasons", async () => {
  mocks.list.mockReturnValue([
    createUpdateRunRecordFixture("run-2", {
      status: "failed",
      phase: "verifying",
      reason: "gateway did not answer",
      target: { version: "2026.10.9" },
    }),
    createUpdateRunRecordFixture("run-1", { status: "succeeded", target: { tag: "beta" } }),
  ]);
  const out = runtime();

  await updateHistoryCommand({}, out);

  expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ limit: 10 });
  const text = printed(out);
  expect(text).toContain("run-2");
  expect(text).toContain("2026.10.9");
  expect(text).toContain("gateway did not answer");
  expect(text).toContain("beta");
  expect(out.exit).not.toHaveBeenCalled();
});

it("caps the requested window at the ledger maximum", async () => {
  mocks.list.mockReturnValue([]);
  const out = runtime();

  await updateHistoryCommand({ limit: 500 }, out);

  expect(mocks.list).toHaveBeenCalledWith({ limit: 100 });
  expect(printed(out)).toContain("No recorded update runs.");
});

it("stays quiet about widening when the window is already full", async () => {
  mocks.list.mockReturnValue([createUpdateRunRecordFixture("run-1", {})]);
  const out = runtime();

  await updateHistoryCommand({ limit: 100 }, out);

  expect(printed(out)).not.toContain("raise --limit");
});

it("prints the owning report for a single run", async () => {
  mocks.get.mockReturnValue(createUpdateRunRecordFixture("run-9", { status: "succeeded" }));
  const out = runtime();

  await updateHistoryCommand({ runId: "run-9" }, out);

  expect(mocks.get).toHaveBeenCalledWith("run-9");
  // The report body belongs to the run-report owner; this surface only routes it.
  expect(out.log).toHaveBeenCalled();
  expect(out.exit).not.toHaveBeenCalled();
});

it("fails when the requested run is not recorded", async () => {
  mocks.get.mockReturnValue(undefined);
  const out = runtime();

  await updateHistoryCommand({ runId: "run-missing" }, out);

  expect(out.error).toHaveBeenCalledWith(
    "No recorded update run run-missing. Run openclaw update history to list recorded runs.",
  );
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("rejects a blank run id instead of listing", async () => {
  await expect(updateHistoryCommand({ runId: "  " }, runtime())).rejects.toThrow(
    "--run must not be blank",
  );
  expect(mocks.list).not.toHaveBeenCalled();
});

it("emits the public projection as JSON", async () => {
  mocks.list.mockReturnValue([
    createUpdateRunRecordFixture("run-1", {
      origin: { driver: { host: "test-host", pid: 123, startIdentity: "1" } },
    }),
  ]);
  const out = runtime();

  await updateHistoryCommand({ json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      runs: [
        expect.objectContaining({
          runId: "run-1",
          origin: { driver: { host: "test-host", pid: 123, startIdentity: "1" } },
        }),
      ],
    }),
    2,
  );
  expect(out.log).not.toHaveBeenCalled();
});

it("formats an empty history without a table", () => {
  expect(renderUpdateHistory([])).toBe("No recorded update runs.");
});
