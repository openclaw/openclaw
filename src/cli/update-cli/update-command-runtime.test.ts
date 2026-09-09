import { afterEach, describe, expect, it, vi } from "vitest";
import { updateCommand } from "./update-command.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(() => {
    throw new Error("update preparation reached on unsupported Node");
  }),
  runtime: { error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));
vi.mock("./update-command-run.js", () => ({ prepareUpdateCommand: mocks.prepare }));
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
    await updateCommand({ json: true });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
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
