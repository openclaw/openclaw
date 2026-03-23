import { describe, expect, it, vi } from "vitest";
import { tryHandleRootHelpFastPath, tryHandleStatusJsonFastPath } from "./entry.js";
import { createNonExitingRuntime } from "./runtime.js";

describe("entry root help fast path", () => {
  it("renders root help without importing the full program", () => {
    const outputRootHelpMock = vi.fn();

    const handled = tryHandleRootHelpFastPath(["node", "openclaw", "--help"], {
      outputRootHelp: outputRootHelpMock,
    });

    expect(handled).toBe(true);
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
  });

  it("ignores non-root help invocations", () => {
    const outputRootHelpMock = vi.fn();

    const handled = tryHandleRootHelpFastPath(["node", "openclaw", "status", "--help"], {
      outputRootHelp: outputRootHelpMock,
    });

    expect(handled).toBe(false);
    expect(outputRootHelpMock).not.toHaveBeenCalled();
  });
});

describe("entry status json fast path", () => {
  it("routes status --json without importing the full program", async () => {
    const statusJsonCommandMock = vi.fn(async () => {});
    const runtime = createNonExitingRuntime();

    const handled = tryHandleStatusJsonFastPath(["node", "openclaw", "status", "--json"], {
      statusJsonCommand: statusJsonCommandMock,
      runtime,
    });

    expect(handled).toBe(true);
    await vi.waitFor(() => expect(statusJsonCommandMock).toHaveBeenCalledTimes(1));
    expect(statusJsonCommandMock).toHaveBeenCalledWith(
      { deep: false, all: false, usage: false, timeoutMs: undefined },
      runtime,
    );
  });

  it("ignores status subcommands and help/version invocations", () => {
    const statusJsonCommandMock = vi.fn(async () => {});
    const runtime = createNonExitingRuntime();

    expect(
      tryHandleStatusJsonFastPath(["node", "openclaw", "status", "doctor", "--json"], {
        statusJsonCommand: statusJsonCommandMock,
        runtime,
      }),
    ).toBe(false);
    expect(
      tryHandleStatusJsonFastPath(["node", "openclaw", "status", "--json", "--help"], {
        statusJsonCommand: statusJsonCommandMock,
        runtime,
      }),
    ).toBe(false);
    expect(statusJsonCommandMock).not.toHaveBeenCalled();
  });
});
