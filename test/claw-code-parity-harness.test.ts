import { describe, expect, it } from "vitest";
import {
  collectClawCodeParityHarnessSnapshot,
  main as parityHarnessMain,
} from "../scripts/check-claw-code-parity-harness.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

const paritySnapshotPromise = collectClawCodeParityHarnessSnapshot();
const parityJsonOutputPromise = getJsonOutput(parityHarnessMain);

async function getJsonOutput(
  main: (argv: string[], io: ReturnType<typeof createCapturedIo>["io"]) => Promise<number>,
) {
  const captured = createCapturedIo();
  const exitCode = await main(["--json"], captured.io);
  return {
    exitCode,
    stderr: captured.readStderr(),
    json: JSON.parse(captured.readStdout()),
  };
}

describe("claw-code parity harness", () => {
  it("matches the checked-in parity baseline snapshot", async () => {
    const snapshot = await paritySnapshotPromise;
    const jsonOutput = await parityJsonOutputPromise;

    expect(snapshot.length).toBe(9);
    expect(snapshot[0]?.lane).toBe(1);
    expect(snapshot[8]?.lane).toBe(9);
    expect(snapshot.filter((entry) => entry.status === "present").length).toBe(9);
    expect(snapshot.filter((entry) => entry.status === "missing").length).toBe(0);
    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual(snapshot);
  });
});
