import { afterEach, describe, expect, it, vi } from "vitest";
import * as nodeSqlite from "../../../node-sqlite.mjs";
import * as retainedRuntime from "../../infra/update-retained-runtime.js";
import { ExitError } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as immutableUpdate from "./update-command-immutable.js";
import { updateCommand } from "./update-command.js";

const mocks = vi.hoisted(() => ({
  stateAdmission: vi.fn(() => {
    throw new Error("state admission reached on unsupported Node");
  }),
  runtime: { error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
  preparePostgres: vi.fn<() => Promise<void>>(async () => {}),
}));
// mock-isolation: Admission tests must not create process-wide PostgreSQL services.
vi.mock("../../infra/postgres-sync/pool.js", () => ({
  preparePostgresPoolForUpdate: mocks.preparePostgres,
}));
vi.mock("../../state/openclaw-state-ownership-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-ownership-preflight.js")>()),
  assertOpenClawStateWriteAllowedAtPath: mocks.stateAdmission,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("waits for PostgreSQL services before entering runtime retention", async () => {
  const preparing = createDeferredCore();
  const ready = createDeferredCore();
  mocks.preparePostgres.mockImplementationOnce(() => {
    preparing.resolve();
    return ready.promise;
  });
  vi.spyOn(immutableUpdate, "tryRunImmutableUpdateCommand").mockResolvedValue(false);
  const retain = vi
    .spyOn(retainedRuntime, "withRetainedUpdateRuntime")
    .mockResolvedValue(undefined);
  const update = updateCommand({ json: true });
  try {
    await preparing.promise;
    expect(retain).not.toHaveBeenCalled();
    ready.resolve();
    await update;
    expect(retain).toHaveBeenCalledOnce();
  } finally {
    ready.resolve();
    await update;
  }
});

describe("unsupported CLI Node update admission", () => {
  it.each([true, false])(
    "refuses unsafe CLI admission before stateful preparation (SQLite=%s)",
    async (lossless) => {
      const node = lossless ? "24.15.0" : "26.0.0";
      vi.stubGlobal("process", {
        ...process,
        versions: { ...process.versions, bun: undefined, node },
      });
      const capabilities = await nodeSqlite.detectCurrentSqliteCapabilities();
      vi.spyOn(nodeSqlite, "detectCurrentSqliteCapabilities").mockResolvedValue({
        ...capabilities,
        text: lossless,
      });
      await expect(updateCommand({ json: true })).rejects.toEqual(new ExitError(1));
      expect(mocks.stateAdmission).not.toHaveBeenCalled();
      const refusal = mocks.runtime.writeJson.mock.calls[0]?.[0];
      expect(refusal.error).toContain(`detected: Node ${node} at ${process.execPath}`);
      expect(refusal.error).toContain("Failing check node-runtime");
      expect(refusal.error).toContain("Update install root:");
      expect(refusal.error).toContain("Update binary:");
      expect(refusal.error).toContain(">=24.16.0 <25");
      expect(refusal.error).toContain(">=26.1.0");
      expect(refusal.error).toContain("Node 26 recommended");
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          mode: "unknown",
          reason: "node-runtime-preflight",
          error: expect.stringContaining("nvm install 26"),
        }),
      );
    },
  );
});
