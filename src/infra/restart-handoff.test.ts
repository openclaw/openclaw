import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  consumeGatewayRestartHandoffForExitedProcessSync,
  formatGatewayRestartHandoffDiagnostic,
  GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
  readGatewayRestartHandoffSync,
  writeGatewayRestartHandoffSync,
} from "./restart-handoff.js";
import type { GatewayRestartHandoff } from "./restart-handoff.js";

const tempDirs: string[] = [];
function createHandoffEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-handoff-"));
  tempDirs.push(dir);
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
  };
}

function expectWrittenHandoff(
  opts: Parameters<typeof writeGatewayRestartHandoffSync>[0],
): GatewayRestartHandoff {
  const handoff = writeGatewayRestartHandoffSync(opts);
  if (handoff === null) {
    throw new Error("Expected gateway restart handoff to be written");
  }
  return handoff;
}

describe("gateway restart handoff", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("writes a supervisor handoff for an exited gateway process", () => {
    const env = createHandoffEnv();

    const handoff = expectWrittenHandoff({
      env,
      pid: 12_345,
      processInstanceId: "gateway-instance-1",
      reason: "plugin source changed",
      restartKind: "full-process",
      supervisorMode: "launchd",
      createdAt: 1_000,
    });

    expect(handoff).toMatchObject({
      kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
      version: 1,
      pid: 12_345,
      processInstanceId: "gateway-instance-1",
      reason: "plugin source changed",
      source: "plugin-change",
      restartKind: "full-process",
      supervisorMode: "launchd",
      createdAt: 1_000,
      expiresAt: 61_000,
    });
    expect(readGatewayRestartHandoffSync(env, 1_500)).toMatchObject({
      pid: 12_345,
      reason: "plugin source changed",
    });
  });

  it("consumes a fresh handoff by exited pid instead of current process pid", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: process.pid + 1,
      reason: "update.run",
      restartKind: "update-process",
      supervisorMode: "systemd",
      createdAt: 2_000,
    });

    const consumed = consumeGatewayRestartHandoffForExitedProcessSync({
      env,
      exitedPid: process.pid + 1,
      now: 2_001,
    });
    expect(readGatewayRestartHandoffSync(env, 2_001)).toBeNull();
  });

  it("rejects handoffs for a different exited pid and clears them", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: 111,
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
    });

    expect(
      consumeGatewayRestartHandoffForExitedProcessSync({
        env,
        exitedPid: 222,
        now: 1_001,
      }),
    ).toBeNull();
  });

  it("rejects a handoff when the supplied process instance does not match", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: 111,
      processInstanceId: "gateway-instance-1",
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
    });

    expect(
      consumeGatewayRestartHandoffForExitedProcessSync({
        env,
        exitedPid: 111,
        processInstanceId: "gateway-instance-2",
        now: 1_001,
      }),
    ).toBeNull();
  });

  it("rejects expired SQLite handoffs", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: 111,
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
      ttlMs: 1_000,
    });
    expect(readGatewayRestartHandoffSync(env, 2_001)).toBeNull();
    expect(
      consumeGatewayRestartHandoffForExitedProcessSync({
        env,
        exitedPid: 111,
        now: 2_001,
      }),
    ).toBeNull();
  });

  it("formats a concise diagnostic line for status surfaces", () => {
    expect(
      formatGatewayRestartHandoffDiagnostic(
        {
          kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
          version: 1,
          intentId: "intent-1",
          pid: 12_345,
          createdAt: 10_000,
          expiresAt: 70_000,
          reason: "plugin source changed",
          source: "plugin-change",
          restartKind: "full-process",
          supervisorMode: "launchd",
        },
        12_500,
      ),
    ).toBe(
      "Recent restart handoff: full-process via launchd; source=plugin-change; reason=plugin source changed; pid=12345; age=2s; expiresIn=57s",
    );
  });

  it("formats restart reasons as a single diagnostic line", () => {
    expect(
      formatGatewayRestartHandoffDiagnostic(
        {
          kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
          version: 1,
          intentId: "intent-1",
          pid: 12_345,
          createdAt: 10_000,
          expiresAt: 70_000,
          reason: "ok\nFake: bad",
          source: "operator-restart",
          restartKind: "full-process",
          supervisorMode: "external",
        },
        12_500,
      ),
    ).toBe(
      "Recent restart handoff: full-process via external; source=operator-restart; reason=ok Fake: bad; pid=12345; age=2s; expiresIn=57s",
    );
  });
});
