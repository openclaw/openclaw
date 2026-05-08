import { describe, expect, it, vi } from "vitest";
import { tryHandleRootHelpFastPath } from "./entry.js";

const outputPrecomputedRootHelpTextMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("./cli/root-help-metadata.js", () => ({
  outputPrecomputedRootHelpText: outputPrecomputedRootHelpTextMock,
}));

describe("entry root help fast path", () => {
  it("prefers precomputed root help text when available", async () => {
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    const handled = tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      env: {},
    });
    await vi.dynamicImportSettled();

    expect(handled).toBe(true);
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
  });

  it("renders root help without importing the full program", async () => {
    const outputRootHelpMock = vi.fn();

    const handled = tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      outputRootHelp: outputRootHelpMock,
      env: {},
    });
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
  });

  it("ignores non-root help invocations", () => {
    const outputRootHelpMock = vi.fn();

    const handled = tryHandleRootHelpFastPath(["node", "openclaw", "status", "--help"], {
      outputRootHelp: outputRootHelpMock,
      env: {},
    });

    expect(handled).toBe(false);
    expect(outputRootHelpMock).not.toHaveBeenCalled();
  });

  it("skips the host help fast path when a container target is active", () => {
    const outputRootHelpMock = vi.fn();

    const handled = tryHandleRootHelpFastPath(
      ["node", "openclaw", "--container", "demo", "--help"],
      {
        outputRootHelp: outputRootHelpMock,
        env: {},
      },
    );

    expect(handled).toBe(false);
    expect(outputRootHelpMock).not.toHaveBeenCalled();
  });
});
