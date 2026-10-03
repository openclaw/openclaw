import { afterEach, expect, it, vi } from "vitest";
import { configureHeapRigTurns } from "../../scripts/lib/gateway-heap-rig-turns.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("does not launch a turn when admission closes during asynchronous preparation", async () => {
  const driver = await configureHeapRigTurns({}, tempDirs.make("heap-rig-turns-"), 19549);
  const rpc = vi.fn(() => {
    throw new Error("Expired admission launched a Gateway request");
  });
  let admissionOpen = true;
  const turn = driver.runTurn(rpc, 0, {
    agentId: "main",
    canStart: () => admissionOpen,
  });
  admissionOpen = false;

  await expect(turn).resolves.toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});
