import { describe, expect, it } from "vitest";
import {
  collectWebSearchProviderBoundaryInventory,
  main,
} from "../scripts/check-web-search-provider-boundaries.mjs";

const inventoryPromise = collectWebSearchProviderBoundaryInventory();
const jsonOutputPromise = getJsonOutput();

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

async function getJsonOutput() {
  const captured = createCapturedIo();
  const exitCode = await main(["--json"], captured.io);
  return {
    exitCode,
    stderr: captured.readStderr(),
    json: JSON.parse(captured.readStdout()),
  };
}

describe("web search provider boundary inventory", () => {
  it("stays empty, core-only, and sorted", async () => {
    const inventory = await inventoryPromise;
    const jsonOutput = await jsonOutputPromise;

    expect(inventory).toEqual([]);
    expect(inventory.some((entry) => entry.file.startsWith("extensions/"))).toBe(false);
    expect(
      [...inventory].toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(inventory);
    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual([]);
  });
});
