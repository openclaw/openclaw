import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("unsupported CLI Node update admission", () => {
  it.each(["22.23.2", "26.0.0"])("refuses Node %s before stateful preparation", async (node) => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, node } });
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
