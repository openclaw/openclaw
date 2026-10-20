import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSystemNodeInfo: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  ...mocks,
}));

import { emitNodeRuntimeWarning } from "./daemon-install-runtime-warning.js";

afterEach(() => vi.resetAllMocks());

function emit(
  warn: ReturnType<typeof vi.fn>,
  nodeProgram = "node",
  runtime: "node" | "bun" = "node",
) {
  return emitNodeRuntimeWarning({
    env: { PATH: "/usr/bin" },
    runtime,
    nodeProgram,
    warn,
    title: "Gateway runtime",
  });
}

describe("emitNodeRuntimeWarning", () => {
  it.each([
    { selected: "/opt/node", status: "supported", warns: false },
    { selected: "/opt/node", status: "unsupported", warns: true },
    { selected: "/opt/node", status: "probe-failed", warns: true },
    { selected: "/usr/bin/node", status: "supported", warns: true },
  ])("scopes system warnings with $selected ($status)", async ({ selected, status, warns }) => {
    const warn = vi.fn();
    const systemNode = { path: "/usr/bin/node", status: "unsupported" };
    mocks.resolveSystemNodeInfo.mockResolvedValue(systemNode);
    mocks.resolveNodeRuntimeInfo.mockResolvedValue({ status });
    mocks.renderSystemNodeWarning.mockReturnValue("System Node SQLite is unsafe");

    await emit(warn, selected);
    expect(mocks.resolveSystemNodeInfo).toHaveBeenCalledWith({ env: { PATH: "/usr/bin" } });
    expect(mocks.renderSystemNodeWarning).toHaveBeenCalledWith(systemNode, selected);

    expect(warn.mock.calls).toEqual(
      warns ? [["System Node SQLite is unsafe", "Gateway runtime"]] : [],
    );
  });

  it("does not emit when warning helper returns null", async () => {
    const warn = vi.fn();
    mocks.resolveSystemNodeInfo.mockResolvedValue(null);
    mocks.renderSystemNodeWarning.mockReturnValue(null);

    await emit(warn);

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not run Node diagnostics for Bun", async () => {
    const warn = vi.fn();

    await emit(warn, "/home/test/.bun/bin/bun", "bun");

    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
