import { describe, expect, it } from "vitest";
import {
  collectWebFetchProviderBoundaryViolations,
  main,
} from "../scripts/check-web-fetch-provider-boundaries.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

const violationsPromise = collectWebFetchProviderBoundaryViolations();
const jsonOutputPromise = getJsonOutput();

async function getJsonOutput() {
  const captured = createCapturedIo();
  const exitCode = await main(["--json"], captured.io);
  return {
    exitCode,
    stderr: captured.readStderr(),
    json: JSON.parse(captured.readStdout()),
  };
}

describe("web fetch provider boundary inventory", () => {
  it("keeps Firecrawl-specific fetch logic out of core runtime/tooling", async () => {
    const violations = await violationsPromise;
    const jsonOutput = await jsonOutputPromise;

    expect(violations).toEqual([]);
    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual([]);
  });
});
