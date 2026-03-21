import { describe, expect, it } from "vitest";
import {
  collectWebSearchProviderBoundaryInventory,
  main,
} from "../scripts/check-web-search-provider-boundaries.mjs";

function createCapturedIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
        },
      },
      stderr: {
        write(chunk) {
          stderr += String(chunk);
        },
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

describe("web search provider boundary inventory", () => {
  it("has no remaining production inventory in core", async () => {
    const inventory = await collectWebSearchProviderBoundaryInventory();

    expect(inventory).toEqual([]);
  });

  it("ignores extension-owned registrations", async () => {
    const inventory = await collectWebSearchProviderBoundaryInventory();

    expect(inventory.some((entry) => entry.file.startsWith("extensions/"))).toBe(false);
  });

  it("produces stable sorted output", async () => {
    const first = await collectWebSearchProviderBoundaryInventory();
    const second = await collectWebSearchProviderBoundaryInventory();

    expect(second).toEqual(first);
    expect(
      [...first].toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(first);
  });

  it("script json output is empty", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });
});
