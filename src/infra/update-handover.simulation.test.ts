// Temp-dir package/state simulations only. No real service or OpenClaw state is touched.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runUpdateHandover } from "./update-handover.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function createStub(root: string, body: string): Promise<string> {
  const script = path.join(root, "stub-gateway.sh");
  await fs.writeFile(script, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  return script;
}

async function replaceDirectory(source: string, target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
}

async function setup(mode: "complete" | "verify-fail" | "confirm-timeout") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-transaction-"));
  roots.push(root);
  const live = path.join(root, "live-package");
  const retained = path.join(root, "retained-package");
  const candidate = path.join(root, "candidate-package");
  const state = path.join(root, "state");
  const snapshot = path.join(root, "state-snapshot");
  const transcript = path.join(root, "transcript.txt");
  await Promise.all([live, retained, candidate, state].map((dir) => fs.mkdir(dir)));
  await Promise.all([
    fs.writeFile(path.join(live, "version"), "old"),
    fs.writeFile(path.join(retained, "version"), "old"),
    fs.writeFile(path.join(candidate, "version"), "new"),
    fs.writeFile(path.join(state, "value"), "old-state"),
  ]);
  const stub = await createStub(
    root,
    mode === "verify-fail"
      ? `printf 'verify:failed\\n' >> '${transcript}'; exit 1`
      : `printf 'verify:ok\\n' >> '${transcript}'`,
  );
  const record = async (line: string) => {
    await fs.appendFile(transcript, `${line}\n`);
  };
  return {
    live,
    state,
    transcript,
    run: () =>
      runUpdateHandover({
        confirmationTier: "delivery",
        verifyNewPackage: async () =>
          await execFileAsync(stub, [], { cwd: candidate }).then(
            () => true,
            () => false,
          ),
        snapshotState: async () => {
          await record("snapshot:state");
          await fs.cp(state, snapshot, { recursive: true });
        },
        swapPackage: async () => {
          await record("swap:package");
          await replaceDirectory(candidate, live);
          await fs.writeFile(path.join(state, "value"), "migrated-state");
        },
        restartService: async () => record("service:restart"),
        waitForHealthy: async () => {
          await record("health:ok");
          return true;
        },
        waitForConfirmation: async () => {
          const confirmed = mode === "complete";
          await record(confirmed ? "confirm:acked" : "confirm:timeout");
          return confirmed;
        },
        cleanupCompleted: async () => {
          await record("cleanup:snapshot");
          await fs.rm(snapshot, { recursive: true });
        },
        stopService: async () => record("rollback:stop"),
        restorePackage: async () => {
          await record("rollback:package");
          await replaceDirectory(retained, live);
        },
        restoreState: async () => {
          await record("rollback:state");
          await replaceDirectory(snapshot, state);
        },
        startService: async () => record("rollback:start"),
        markFailed: async (reason) => record(`failed:${reason}`),
      }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform !== "win32")("update transaction simulations", () => {
  it("passes verify and delivery confirmation", async () => {
    const simulation = await setup("complete");
    expect((await simulation.run()).phase).toBe("complete");
    expect(await fs.readFile(simulation.transcript, "utf8")).toBe(
      "verify:ok\nsnapshot:state\nswap:package\nservice:restart\nhealth:ok\nconfirm:acked\ncleanup:snapshot\n",
    );
    expect(await fs.readFile(path.join(simulation.live, "version"), "utf8")).toBe("new");
  });

  it("restores package without restart when verify fails", async () => {
    const simulation = await setup("verify-fail");
    expect((await simulation.run()).phase).toBe("rolled-back");
    expect(await fs.readFile(simulation.transcript, "utf8")).toBe(
      "verify:failed\nfailed:new package startup verification failed\nrollback:package\n",
    );
    expect(await fs.readFile(path.join(simulation.live, "version"), "utf8")).toBe("old");
  });

  it("restores package and snapshot after confirmation timeout", async () => {
    const simulation = await setup("confirm-timeout");
    expect((await simulation.run()).phase).toBe("rolled-back");
    expect(await fs.readFile(simulation.transcript, "utf8")).toBe(
      "verify:ok\nsnapshot:state\nswap:package\nservice:restart\nhealth:ok\nconfirm:timeout\nfailed:delivery confirmation timed out\nrollback:stop\nrollback:package\nrollback:state\nrollback:start\n",
    );
    expect(await fs.readFile(path.join(simulation.live, "version"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(simulation.state, "value"), "utf8")).toBe("old-state");
  });
});
