// Daemon install runtime warning tests cover Node runtime compatibility notices during service install.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSystemNodeInfo: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  resolveNodeRuntimeInfo: mocks.resolveNodeRuntimeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

import { emitNodeRuntimeWarning } from "./daemon-install-runtime-warning.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("emitNodeRuntimeWarning", () => {
  it.each([
    { selected: "/opt/node", status: "supported", warns: false },
    { selected: "/opt/node", status: "unsupported", warns: true },
    { selected: "/opt/node", status: "probe-failed", warns: true },
    { selected: "/usr/bin/node", status: "supported", warns: true },
  ])("scopes system warnings with $selected ($status)", async ({ selected, status, warns }) => {
    const warn = vi.fn();
    mocks.resolveSystemNodeInfo.mockResolvedValue({ path: "/usr/bin/node", status: "unsupported" });
    mocks.resolveNodeRuntimeInfo.mockResolvedValue({ status });
    mocks.renderSystemNodeWarning.mockReturnValue("System Node SQLite is unsafe");

    await emitNodeRuntimeWarning({
      env: { PATH: "/usr/bin" },
      runtime: "node",
      nodeProgram: selected,
      warn,
      title: "Gateway runtime",
    });

    expect(warn.mock.calls).toEqual(
      warns ? [["System Node SQLite is unsafe", "Gateway runtime"]] : [],
    );
  });

  it("emits warning when system node check returns one", async () => {
    const warn = vi.fn();
    mocks.resolveSystemNodeInfo.mockResolvedValue({ path: "/usr/bin/node", version: "18.0.0" });
    mocks.renderSystemNodeWarning.mockReturnValue("Node too old");
    mocks.resolveNodeRuntimeInfo.mockResolvedValue({ status: "unsupported" });

    await emitNodeRuntimeWarning({
      env: { PATH: "/usr/bin" },
      runtime: "node",
      nodeProgram: "/opt/node",
      warn,
      title: "Node daemon runtime",
    });

    expect(mocks.resolveSystemNodeInfo).toHaveBeenCalledWith({
      env: { PATH: "/usr/bin" },
    });
    expect(mocks.renderSystemNodeWarning).toHaveBeenCalledWith(
      { path: "/usr/bin/node", version: "18.0.0" },
      "/opt/node",
    );
    expect(warn).toHaveBeenCalledWith("Node too old", "Node daemon runtime");
  });

  it("does not emit when warning helper returns null", async () => {
    const warn = vi.fn();
    mocks.resolveSystemNodeInfo.mockResolvedValue(null);
    mocks.renderSystemNodeWarning.mockReturnValue(null);

    await emitNodeRuntimeWarning({
      env: {},
      runtime: "node",
      nodeProgram: "node",
      warn,
      title: "Gateway runtime",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not run Node diagnostics for Bun", async () => {
    const warn = vi.fn();

    await emitNodeRuntimeWarning({
      env: {},
      runtime: "bun",
      nodeProgram: "/home/test/.bun/bin/bun",
      warn,
      title: "Gateway runtime",
    });

    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
