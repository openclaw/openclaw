import { afterEach, describe, expect, it, vi } from "vitest";
import * as nodeSqlite from "../../../node-sqlite.mjs";
import { ExitError } from "../../runtime.js";
import { updateCommand } from "./update-command.js";

const mocks = vi.hoisted(() => ({
  stateAdmission: vi.fn(() => {
    throw new Error("state admission reached on unsupported Node");
  }),
  runtime: { error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));
vi.mock("../../state/openclaw-state-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-ownership.js")>()),
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

describe("unsupported CLI Node update admission", () => {
  it("admits a capability-passing Node build outside the release table", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, node: "24.15.0" } });
    await expect(updateCommand({ json: true })).rejects.toThrow("state admission reached");
    expect(mocks.stateAdmission).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it.each(["22.23.2", "26.0.0"])("refuses Node %s before stateful preparation", async (node) => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, node } });
    vi.spyOn(nodeSqlite, "detectCurrentSqliteCapabilities").mockReturnValue({
      ...nodeSqlite.detectCurrentSqliteCapabilities(),
      text: false,
    });
    await expect(updateCommand({ json: true })).rejects.toEqual(new ExitError(1));
    expect(mocks.stateAdmission).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        mode: "unknown",
        reason: "node-runtime-preflight",
        error: expect.stringContaining("nvm install 26"),
      }),
    );
  });
});
