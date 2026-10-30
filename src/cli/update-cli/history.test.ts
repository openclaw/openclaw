import { expect, it, vi } from "vitest";
import { createUpdateRunRecordFixture } from "../../infra/update-run-record.test-support.js";
import { renderUpdateHistory, updateHistoryCommand, type UpdateHistorySource } from "./history.js";

function source(overrides: Partial<UpdateHistorySource> = {}): UpdateHistorySource {
  return { list: vi.fn(() => []), get: vi.fn(() => undefined), ...overrides };
}

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

function printed(out: ReturnType<typeof runtime>): string {
  return out.log.mock.calls.map(([line]) => String(line)).join("\n");
}

it("lists recorded runs with their target and reason", async () => {
  const reads = source({
    list: vi.fn(() => [
      createUpdateRunRecordFixture("run-2", {
        status: "failed",
        phase: "verification",
        reason: "gateway did not answer",
        target: { version: "2026.10.9" },
      }),
      createUpdateRunRecordFixture("run-1", { status: "succeeded", target: { tag: "beta" } }),
    ]),
  });
  const out = runtime();

  await updateHistoryCommand({}, out, reads);

  expect(reads.list).toHaveBeenCalledExactlyOnceWith({ limit: 10 });
  const text = printed(out);
  expect(text).toContain("2026.10.9");
  expect(text).toContain("gateway did not answer");
  expect(text).toContain("beta");
  expect(out.exit).not.toHaveBeenCalled();
});

it("caps the requested window at the ledger maximum", async () => {
  const reads = source();
  const out = runtime();

  await updateHistoryCommand({ limit: 500 }, out, reads);

  expect(reads.list).toHaveBeenCalledWith({ limit: 100 });
  expect(printed(out)).toContain("No recorded update runs.");
});

it("stays quiet about widening when the window is not full", async () => {
  const reads = source({ list: vi.fn(() => [createUpdateRunRecordFixture("run-1", {})]) });
  const out = runtime();

  await updateHistoryCommand({ limit: 5 }, out, reads);

  expect(printed(out)).not.toContain("raise --limit");
});

it("prints the owning report for a single run", async () => {
  const reads = source({
    get: vi.fn(() => createUpdateRunRecordFixture("run-9", { status: "succeeded" })),
  });
  const out = runtime();

  await updateHistoryCommand({ runId: "run-9" }, out, reads);

  expect(reads.get).toHaveBeenCalledWith("run-9");
  // The report body belongs to the run-report owner; this surface only routes it.
  expect(out.log).toHaveBeenCalled();
  expect(out.exit).not.toHaveBeenCalled();
});

it("fails when the requested run is not recorded", async () => {
  const out = runtime();

  await updateHistoryCommand({ runId: "run-missing" }, out, source());

  expect(out.error).toHaveBeenCalledWith(
    "No recorded update run run-missing. Run openclaw update history to list recorded runs.",
  );
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("rejects a blank run id instead of listing", async () => {
  const reads = source();

  await expect(updateHistoryCommand({ runId: "  " }, runtime(), reads)).rejects.toThrow(
    "--run must not be blank",
  );
  expect(reads.list).not.toHaveBeenCalled();
});

it("emits the public projection as JSON", async () => {
  const reads = source({
    list: vi.fn(() => [
      createUpdateRunRecordFixture("run-1", {
        origin: { driver: { host: "test-host", pid: 123, startIdentity: "1" } },
      }),
    ]),
  });
  const out = runtime();

  await updateHistoryCommand({ json: true }, out, reads);

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
