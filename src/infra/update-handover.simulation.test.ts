// Simulations execute only temp-dir shell stubs; no real Gateway or state directory is touched.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runUpdateHandover } from "./update-handover.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function createStub(root: string, name: string, body: string): Promise<string> {
  const scriptPath = path.join(root, name);
  await fs.writeFile(scriptPath, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  return scriptPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

async function setup(confirmationExit: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handover-sim-"));
  roots.push(root);
  const transcript = path.join(root, "transcript.txt");
  const operation = async (name: string) => {
    const stub = await createStub(
      root,
      `${name}.sh`,
      `printf '%s\\n' '${name}' >> '${transcript}'`,
    );
    return async () => {
      await execFileAsync(stub);
    };
  };
  const confirm = await createStub(root, "confirm.sh", `exit ${confirmationExit}`);
  return {
    transcript,
    deps: {
      waitForInternalHealth: async () => true,
      pauseOldChannels: await operation("pause-old"),
      startNewChannels: await operation("start-new"),
      confirmDelivery: async () =>
        await execFileAsync(confirm).then(
          () => true,
          () => false,
        ),
      confirmHumanReply: async () =>
        await execFileAsync(confirm).then(
          () => true,
          () => false,
        ),
      stopNewChannels: await operation("stop-new"),
      restorePrevious: await operation("restore-previous"),
      resumeOldChannels: await operation("resume-old"),
    },
  };
}

describe.runIf(process.platform !== "win32")("update handover shell simulations", () => {
  it("completes a delivery-confirmed handover without overlapping channels", async () => {
    const simulation = await setup(0);
    expect(
      (
        await runUpdateHandover({
          confirmationTier: "delivery",
          ...simulation.deps,
        })
      ).phase,
    ).toBe("completed");
    expect(await fs.readFile(simulation.transcript, "utf8")).toBe("pause-old\nstart-new\n");
  });

  it("stops new channels before restoring and resuming old on human timeout", async () => {
    const simulation = await setup(1);
    expect(
      (
        await runUpdateHandover({
          confirmationTier: "human",
          ...simulation.deps,
        })
      ).phase,
    ).toBe("rolled-back");
    expect(await fs.readFile(simulation.transcript, "utf8")).toBe(
      "pause-old\nstart-new\nstop-new\nrestore-previous\nresume-old\n",
    );
  });
});
