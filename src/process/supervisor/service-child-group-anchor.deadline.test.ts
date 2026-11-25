import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAnchorFixture } from "./anchor-protocol.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const CLOCK_STEP_PRELOAD = fileURLToPath(
  new URL("./service-child-group-anchor.clock-step.preload.mjs", import.meta.url),
);

const PERSIST_GROUP_SCRIPT = `
const { spawn } = require("child_process");
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;

async function runClockStep(offsetMs: number) {
  const dir = tempDirs.make("anchor-clock-step-");
  const stepFile = path.join(dir, "step");
  const { child, generation, send, exited, onMessage } = createAnchorFixture({
    preload: CLOCK_STEP_PRELOAD,
    env: { ANCHOR_TEST_STEP_FILE: stepFile, ANCHOR_TEST_OFFSET: String(offsetMs) },
  });
  let cancelAt = 0;
  let closingAfterCancel = -1;
  onMessage((message) => {
    if (message.type === "ready") {
      setTimeout(() => {
        cancelAt = performance.now();
        send({ type: "cancel", signal: "SIGTERM" });
      }, 1_500);
    } else if (message.type === "root-result") {
      // Land the jump after the budget is seeded but before retirement.
      setTimeout(() => {
        fs.writeFileSync(stepFile, "step");
      }, 500);
    } else if (message.type === "closing") {
      closingAfterCancel = (performance.now() - cancelAt) / 1000;
    }
  });
  child.send({
    type: "start",
    generation,
    command: process.execPath,
    args: ["-e", PERSIST_GROUP_SCRIPT],
    env: {},
    stdinMode: "pipe-closed",
    controlFd: 3,
    lineageFd: 4,
    acknowledgeClosing: true,
  });
  const result = await exited;
  child.kill("SIGKILL");
  return { result, closingAfterCancel };
}

describe("service-child-group-anchor clock-step regression", () => {
  it.skipIf(process.platform === "win32")(
    "keeps retirement on monotonic time under a forward wall-clock jump",
    async () => {
      const { result, closingAfterCancel } = await runClockStep(60_000);
      expect(result.signal).toBe("SIGKILL");
      expect(closingAfterCancel).toBeGreaterThan(4.5);
    },
    30_000,
  );
});
