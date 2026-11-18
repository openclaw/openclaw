import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { withStableDeliveryPreparation } from "./delivery-queue-preparation.js";
import { deliveryQueueProcessEntrypoints } from "./delivery-queue-process-runtime.test-support.js";

const childUrl = resolveRuntimeWorkerUrl(deliveryQueueProcessEntrypoints.preparation);

describe("stable delivery preparation cross-process ownership", () => {
  let stateDir = "";
  let child: ChildProcess | null = null;
  let closed: Promise<unknown[]> | undefined;

  beforeEach(async () => {
    closeOpenClawStateDatabaseForTest();
    stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stable-preparation-")));
  });

  afterEach(async () => {
    child?.kill("SIGKILL");
    await closed;
    child = null;
    closed = undefined;
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("blocks a second process before it can enter modifying policy", async ({ signal }) => {
    const id = "cross-process-stable-intent";
    child = spawn(process.execPath, [...resolveRuntimeWorkerArgv(childUrl), stateDir, id], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    closed = once(child, "close");
    await withinTest(
      new Promise<void>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child?.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.split("\n").some((line) => line.includes('"ready":true'))) {
            resolve();
          }
        });
        child?.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child?.once("error", reject);
        child?.once("exit", (code) => {
          reject(new Error(`child exited before ownership proof (${code}): ${stderr}`));
        });
      }),
      signal,
    );

    const secondRun = vi.fn();
    await expect(withStableDeliveryPreparation({ id, stateDir, run: secondRun })).resolves.toEqual({
      status: "existing",
    });
    expect(secondRun).not.toHaveBeenCalled();
  }, 90_000);
});
