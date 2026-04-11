import { describe, expect, it } from "vitest";
import { buildClawModelerEngineArgs } from "./clawmodeler-cli.js";

describe("clawmodeler cli", () => {
  it("builds Python module arguments for the sidecar", () => {
    expect(
      buildClawModelerEngineArgs(["run", "--workspace", "demo", "--run-id", "baseline"]),
    ).toEqual(["-m", "clawmodeler_engine", "run", "--workspace", "demo", "--run-id", "baseline"]);
  });
});
