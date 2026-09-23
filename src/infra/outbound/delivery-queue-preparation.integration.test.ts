import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { withStableDeliveryPreparation } from "./delivery-queue-preparation.js";
import { deliveryQueueProcessEntrypoints } from "./delivery-queue-process-runtime.test-support.js";

const childUrl = resolveRuntimeWorkerUrl(deliveryQueueProcessEntrypoints.preparation);

describe("stable delivery preparation cross-process ownership", () => {
  let stateDir = "";
  let child: ChildProcess | null = null;

  beforeEach(async () => {
    closeOpenClawStateDatabaseForTest();
    stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stable-preparation-")));
  });

  afterEach(async () => {
    child?.kill("SIGKILL");
    child = null;
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("blocks a second process before it can enter modifying policy", async () => {
    const id = "cross-process-stable-intent";
    child = spawn(process.execPath, [...resolveRuntimeWorkerArgv(childUrl), stateDir, id], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`child timed out: ${stderr}`)), 60_000);
      child?.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.split("\n").some((line) => line.includes('"ready":true'))) {
          clearTimeout(timer);
          resolve();
        }
      });
      child?.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child?.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited before ownership proof (${code}): ${stderr}`));
      });
    });

    const secondRun = vi.fn();
    await expect(withStableDeliveryPreparation({ id, stateDir, run: secondRun })).resolves.toEqual({
      status: "existing",
    });
    expect(secondRun).not.toHaveBeenCalled();
  }, 90_000);
});
