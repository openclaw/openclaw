import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, it } from "vitest";
import { withTimeout } from "../infra/fs-safe.js";
import {
  installLaunchAgent,
  readLaunchAgentRuntime,
  resolveLaunchAgentPlistPath,
  uninstallLaunchAgent,
} from "./launchd.js";
import type { GatewayServiceEnv } from "./service-types.js";

const STARTUP_TIMEOUT_MS = 45_000;
const GUI_DOMAIN = `gui/${process.getuid?.() ?? 501}`;

function canRunLaunchdIntegration(): boolean {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    return false;
  }
  const probe = spawnSync("launchctl", ["print", GUI_DOMAIN], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

const describeLaunchdIntegration = canRunLaunchdIntegration() ? describe : describe.skip;

async function waitForRunningRuntime(env: GatewayServiceEnv, previousPid?: number) {
  const deadline = Date.now() + 30_000;
  let runtime: Awaited<ReturnType<typeof readLaunchAgentRuntime>> | undefined;
  while (Date.now() < deadline) {
    runtime = await readLaunchAgentRuntime(env);
    if (
      runtime.status === "running" &&
      typeof runtime.pid === "number" &&
      runtime.pid > 1 &&
      runtime.pid !== previousPid
    ) {
      return runtime.pid;
    }
    await delay(200);
  }
  throw new Error(
    `Timed out waiting for launchd runtime (status=${runtime?.status ?? "unknown"}, pid=${runtime?.pid ?? "none"})`,
  );
}

describeLaunchdIntegration("launchd integration", () => {
  let env: GatewayServiceEnv;
  let homeDir = "";
  const stdout = new PassThrough();

  beforeAll(async () => {
    const id = `launchd-int-${randomUUID().slice(0, 8)}`;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${id}-`));
    env = {
      HOME: homeDir,
      OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${id}`,
      OPENCLAW_LOG_PREFIX: `gateway-${id}`,
    };
  });

  afterAll(async () => {
    if (env) {
      await uninstallLaunchAgent({ env, stdout }).catch(() => {});
    }
    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps launchd supervision and replaces the PID after SIGTERM", async () => {
    const before = await withTimeout(
      (async () => {
        await installLaunchAgent({
          env,
          stdout,
          programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
        });
        return waitForRunningRuntime(env);
      })(),
      STARTUP_TIMEOUT_MS,
      { message: "Timed out initializing launchd integration runtime" },
    );
    process.kill(before, "SIGTERM");
    await waitForRunningRuntime(env, before);
    await fs.access(resolveLaunchAgentPlistPath(env));
  }, 60_000);
});
