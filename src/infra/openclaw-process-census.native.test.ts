import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
// Rosetta cannot inspect native Darwin arguments; that refusal has its own unit contract.
const translated = process.arch === "x64" && os.cpus()[0]?.model.includes("Apple");

it.runIf(process.platform === "darwin" && !translated)(
  "finds a real non-Node process holding retained handoff paths",
  async () => {
    const retained = fs.realpathSync(dirs.make("handoff-census-"));
    // Ordinary system binaries can carry argument images whose environment
    // the inspector cannot bound; repair matching must still complete.
    const holder = spawn("/bin/sleep", ["60"], { cwd: retained, stdio: "ignore" });
    const closed = once(holder, "close");
    try {
      await once(holder, "spawn");
      const holding = inspectOtherOpenClawProcesses({
        runId: "census-native-run",
        artifactPaths: [retained],
      });
      expect(holding.error).toBeUndefined();
      expect(holding.matchingPids).toContain(holder.pid);
      // Other OpenClaw processes on the host also match by identity, and host
      // processes the census cannot read are environment-specific; this
      // control proves only that the holder is matched by its reference.
      const unrelated = inspectOtherOpenClawProcesses({
        runId: "census-native-unrelated",
        artifactPaths: [`${retained}-unrelated`],
      });
      expect(unrelated.error).toBeUndefined();
      expect(unrelated.matchingPids).not.toContain(holder.pid);
    } finally {
      holder.kill("SIGKILL");
      await closed;
    }
  },
);
