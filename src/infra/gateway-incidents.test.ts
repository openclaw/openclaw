import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readGatewayIncidentEntries,
  readGatewayIncidentState,
  recordGatewayRecoverAttempt,
  recordGatewaySignal,
  recordGatewayStart,
  recordGatewayCrashSync,
  resolveGatewayIncidentsPath,
  resolveGatewayIncidentStatePath,
} from "./gateway-incidents.js";

function makeEnv(tmpRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: tmpRoot,
  };
}

describe("gateway-incidents", () => {
  it("records start/signal/recover and persists restartCount", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-incidents-"));
    const env = makeEnv(tmpRoot);

    const s1 = await recordGatewayStart(env);
    expect(s1.restartCount).toBe(1);

    await recordGatewaySignal("SIGTERM", env);
    await recordGatewayRecoverAttempt({ status: "ok", detail: "noop", env });

    const statePath = resolveGatewayIncidentStatePath(env);
    const logPath = resolveGatewayIncidentsPath(env);

    // Verify files exist.
    await expect(fs.stat(statePath)).resolves.toBeTruthy();
    await expect(fs.stat(logPath)).resolves.toBeTruthy();

    const state = await readGatewayIncidentState(env);
    expect(state.restartCount).toBe(1);
    expect(state.lastSignal).toBe("SIGTERM");

    const entries = await readGatewayIncidentEntries(logPath, { limit: 50 });
    expect(entries.some((e) => e.kind === "start")).toBe(true);
    expect(entries.some((e) => e.kind === "signal" && e.signal === "SIGTERM")).toBe(true);
    expect(entries.some((e) => e.kind === "recover" && e.status === "ok")).toBe(true);
  });

  it("records crash sync", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-incidents-"));
    const env = makeEnv(tmpRoot);

    recordGatewayCrashSync({
      env,
      error: Object.assign(new Error("boom"), { code: "ERR_TEST" }),
      exitCode: 1,
    });

    const logPath = resolveGatewayIncidentsPath(env);
    const entries = await readGatewayIncidentEntries(logPath, { limit: 10 });
    const crash = entries.find((e) => e.kind === "crash");
    expect(crash).toBeTruthy();
    expect(crash?.errorMessage).toContain("boom");
    expect(crash?.errorCode).toBe("ERR_TEST");

    const state = await readGatewayIncidentState(env);
    expect(typeof state.lastCrashAtMs).toBe("number");
    expect(state.lastCrashSummary).toContain("boom");
  });
});
