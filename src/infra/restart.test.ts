// Covers gateway restart process and supervisor paths.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv, withEnv } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: vi.fn(),
    __promisify__: vi.fn(),
  }),
);
const resolveLsofCommandSyncMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFile: execFileMock,
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    } as Partial<typeof import("node:child_process")>,
  );
});

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: (...args: unknown[]) => resolveLsofCommandSyncMock(...args),
}));

vi.mock("../config/paths.js", () => ({
  STATE_DIR: "/tmp/openclaw-state",
  resolveGatewayPort: (...args: unknown[]) => resolveGatewayPortMock(...args),
  resolveStateDir: (env: NodeJS.ProcessEnv = process.env) =>
    env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state",
}));

const { testing, cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } =
  await import("./restart-stale-pids.js");
const {
  testing: restartTesting,
  scheduleGatewaySigusr1Restart,
  triggerOpenClawRestart,
} = await import("./restart.js");
const { requestSafeGatewayRestart } = await import("./restart-coordinator.js");
const { closeOpenClawStateDatabase, openOpenClawStateDatabase } =
  await import("../state/openclaw-state-db.js");

let currentTimeMs = 0;
const envSnapshot = captureFullEnv();

beforeEach(() => {
  execFileMock.mockReset();
  spawnSyncMock.mockReset();
  resolveLsofCommandSyncMock.mockReset();
  resolveGatewayPortMock.mockReset();

  currentTimeMs = 0;
  resolveLsofCommandSyncMock.mockReturnValue("/usr/sbin/lsof");
  resolveGatewayPortMock.mockReturnValue(18789);
  testing.setSleepSyncOverride((ms) => {
    currentTimeMs += ms;
  });
  testing.setDateNowOverride(() => currentTimeMs);
});

afterEach(() => {
  envSnapshot.restore();
  testing.setSleepSyncOverride(null);
  testing.setDateNowOverride(null);
  vi.restoreAllMocks();
});

function setPlatform(platform: NodeJS.Platform): void {
  mockProcessPlatform(platform);
}

function requireFirstSpawnSyncCall(): [unknown, unknown, unknown] {
  const [call] = spawnSyncMock.mock.calls;
  if (!call) {
    throw new Error("expected spawnSync call");
  }
  return call as [unknown, unknown, unknown];
}

describe("restart diagnostics", () => {
  it("redacts session keys in restart warning fields", () => {
    const redacted = restartTesting.formatRestartSessionKeyForLog(
      "agent:main:discord:channel:1515157916540211291",
    );

    expect(redacted).toMatch(/^<redacted:[a-f0-9]{12}>$/);
    expect(redacted).not.toContain("discord");
    expect(redacted).not.toContain("1515157916540211291");
    expect(restartTesting.formatRestartSessionKeyForLog(undefined)).toBe("unspecified");
  });

  it("keeps truncated restart audit payloads valid JSON", () => {
    const serialized = restartTesting.serializeRestartAuditJson({
      context: `quote-heavy:${'\\"'.repeat(15_000)}`,
    });

    expect(serialized).not.toBeNull();
    expect(serialized?.length).toBeLessThanOrEqual(20_000);
    expect(() => JSON.parse(serialized ?? "")).not.toThrow();
    expect(JSON.parse(serialized ?? "")).toEqual(
      expect.objectContaining({
        truncated: true,
        originalLength: expect.any(Number),
        preview: expect.any(String),
      }),
    );
  });

  it("redacts session keys in durable restart audit storage", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-audit-test-"));
    const sessionKey = "agent:main:discord:channel:1515157916540211291";
    try {
      withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
        const result = scheduleGatewaySigusr1Restart({
          delayMs: 60_000,
          reason: "model supplied private restart explanation",
          sessionKey,
          skipCooldown: true,
          audit: {
            source: "gateway.tool.restart",
            sessionKey,
            context: {
              nestedSessionKey: sessionKey,
              token: {
                value: "secret-token-value",
                nested: ["secret-token-in-array"],
              },
              credentials: [
                {
                  password: "nested-password-value",
                },
              ],
            },
            preflight: {
              requesterSessionKey: sessionKey,
              authorization: {
                scheme: "Bearer",
                value: "secret-authorization-value",
              },
            },
          },
        });

        expect(result.ok).toBe(true);
        const { db } = openOpenClawStateDatabase({ env: process.env });
        const row = db
          .prepare(
            "SELECT reason, source, session_key, audit_json, preflight_json FROM gateway_restart_audit ORDER BY created_at DESC LIMIT 1",
          )
          .get() as {
          reason: string | null;
          source: string | null;
          session_key: string | null;
          audit_json: string | null;
          preflight_json: string | null;
        };
        closeOpenClawStateDatabase();
        restartTesting.resetSigusr1State();

        expect(row.reason).toBe("gateway.tool.restart");
        expect(row.source).toBe("gateway.tool.restart");
        expect(row.session_key).toMatch(/^<redacted:[a-f0-9]{12}>$/);
        expect(row.audit_json).toContain("<redacted:");
        expect(row.audit_json).toContain('"token":"<redacted>"');
        expect(row.audit_json).toContain('"credentials":"<redacted>"');
        expect(row.preflight_json).toContain("<redacted:");
        expect(row.preflight_json).toContain('"authorization":"<redacted>"');
        expect(JSON.stringify(row)).not.toContain("1515157916540211291");
        expect(JSON.stringify(row)).not.toContain("secret-token-value");
        expect(JSON.stringify(row)).not.toContain("secret-token-in-array");
        expect(JSON.stringify(row)).not.toContain("nested-password-value");
        expect(JSON.stringify(row)).not.toContain("secret-authorization-value");
        expect(JSON.stringify(row)).not.toContain("model supplied private restart explanation");
      });
    } finally {
      restartTesting.resetSigusr1State();
      closeOpenClawStateDatabase();
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("keeps active task titles out of durable restart audit rows", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-audit-task-"));
    const taskTitle = "Investigate private customer outage prompt";
    try {
      withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
        const result = requestSafeGatewayRestart({
          delayMs: 60_000,
          reason: "test restart audit task title redaction",
          inspect: {
            getQueueSize: () => 0,
            getPendingReplies: () => 0,
            getEmbeddedRuns: () => 0,
            getCronRuns: () => 0,
            getActiveTasks: () => 1,
            getTaskBlockers: () => [
              {
                taskId: "task-privacy",
                runId: "run-privacy",
                status: "running",
                runtime: "acp",
                label: "investigation",
                title: taskTitle,
              },
            ],
          },
        });

        expect(result.preflight.summary).toContain(taskTitle);
        const { db } = openOpenClawStateDatabase({ env: process.env });
        const row = db
          .prepare(
            "SELECT audit_json, preflight_json FROM gateway_restart_audit ORDER BY created_at DESC LIMIT 1",
          )
          .get() as {
          audit_json: string | null;
          preflight_json: string | null;
        };
        closeOpenClawStateDatabase();
        restartTesting.resetSigusr1State();

        expect(row.audit_json).toContain("task-privacy");
        expect(row.preflight_json).toContain("task-privacy");
        expect(JSON.stringify(row)).not.toContain(taskTitle);
      });
    } finally {
      restartTesting.resetSigusr1State();
      closeOpenClawStateDatabase();
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("bounds durable restart audit retention to the newest rows", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-audit-retention-"));
    const maxRows = restartTesting.gatewayRestartAuditMaxRows;
    const baseNowMs = 1_700_000_000_000;
    let nowMs = baseNowMs;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs++);
    try {
      withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
        for (let index = 0; index < maxRows + 3; index += 1) {
          const result = scheduleGatewaySigusr1Restart({
            delayMs: 60_000,
            reason: `retention-${index}`,
            skipCooldown: true,
            audit: { source: "gateway.tool.restart" },
          });
          expect(result.ok).toBe(true);
        }

        const { db } = openOpenClawStateDatabase({ env: process.env });
        const rows = db
          .prepare(
            "SELECT created_at FROM gateway_restart_audit ORDER BY created_at ASC, event_key ASC",
          )
          .all() as Array<{ created_at: number }>;
        closeOpenClawStateDatabase();
        restartTesting.resetSigusr1State();

        expect(rows).toHaveLength(maxRows);
        expect(rows[0]?.created_at).toBeGreaterThanOrEqual(baseNowMs + 3);
        expect(rows.at(-1)?.created_at).toBeGreaterThan(rows[0]?.created_at ?? 0);
      });
    } finally {
      restartTesting.resetSigusr1State();
      closeOpenClawStateDatabase();
      rmSync(stateDir, { force: true, recursive: true });
    }
  });
});

describe.runIf(process.platform !== "win32")("findGatewayPidsOnPortSync", () => {
  it("parses lsof output and filters non-openclaw/current processes", () => {
    const gatewayPidA = process.pid + 1000;
    const gatewayPidB = process.pid + 2000;
    const foreignPid = process.pid + 3000;
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: [
        `p${process.pid}`,
        "copenclaw",
        `p${gatewayPidA}`,
        "copenclaw-gateway",
        `p${foreignPid}`,
        "cnode",
        `p${gatewayPidB}`,
        "cOpenClaw",
      ].join("\n"),
    });

    const pids = findGatewayPidsOnPortSync(18789);

    expect(pids).toEqual([gatewayPidA, gatewayPidB]);
    const [command, args, options] =
      spawnSyncMock.mock.calls.find(
        ([spawnCommand, spawnArgs]) =>
          spawnCommand === "/usr/sbin/lsof" &&
          Array.isArray(spawnArgs) &&
          spawnArgs.includes("-iTCP:18789"),
      ) ?? [];
    expect(command).toBe("/usr/sbin/lsof");
    expect(args).toEqual(["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-Fpc"]);
    expect((options as { encoding?: unknown; timeout?: unknown } | undefined)?.encoding).toBe(
      "utf8",
    );
    expect((options as { encoding?: unknown; timeout?: unknown } | undefined)?.timeout).toBe(2000);
  });

  it("returns empty when lsof fails", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 1,
      stdout: "",
      stderr: "lsof failed",
    });

    expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
  });
});

describe.runIf(process.platform !== "win32")("cleanStaleGatewayProcessesSync", () => {
  it("kills stale gateway pids discovered on the gateway port", () => {
    const stalePidA = process.pid + 1000;
    const stalePidB = process.pid + 2000;
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePidA}`, "copenclaw", `p${stalePidB}`, "copenclaw-gateway"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync();

    expect(killed).toEqual([stalePidA, stalePidB]);
    expect(resolveGatewayPortMock).toHaveBeenCalledWith(undefined, process.env);
    expect(killSpy).toHaveBeenCalledWith(stalePidA, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePidB, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePidA, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(stalePidB, "SIGKILL");
  });

  it("uses explicit port override when provided", () => {
    const stalePid = process.pid + 1000;
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePid}`, "copenclaw"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync(19999);

    expect(killed).toEqual([stalePid]);
    expect(resolveGatewayPortMock).not.toHaveBeenCalled();
    const lsofCalls = spawnSyncMock.mock.calls.filter((call) => call[0] === "/usr/sbin/lsof");
    expect(lsofCalls).toHaveLength(2);
    const [command, args, options] = requireFirstSpawnSyncCall();
    expect(command).toBe("/usr/sbin/lsof");
    expect(args).toEqual(["-nP", "-iTCP:19999", "-sTCP:LISTEN", "-Fpc"]);
    expect((options as { encoding?: unknown; timeout?: unknown } | undefined)?.encoding).toBe(
      "utf8",
    );
    expect((options as { encoding?: unknown; timeout?: unknown } | undefined)?.timeout).toBe(2000);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it("returns empty when no stale listeners are found", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync();

    expect(killed).toStrictEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe("triggerOpenClawRestart", () => {
  it("does not kickstart after bootstrap registers an unloaded LaunchAgent", () => {
    setPlatform("darwin");
    withEnv(
      { VITEST: undefined, NODE_ENV: undefined, HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
      () => {
        const uid = typeof process.getuid === "function" ? process.getuid() : 501;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
          if (command === "/usr/sbin/lsof") {
            return { error: undefined, status: 1, stdout: "" };
          }
          if (command === "launchctl" && args[0] === "kickstart" && args[1] === "-k") {
            return { error: undefined, status: 113, stderr: "service not loaded" };
          }
          if (command === "launchctl" && args[0] === "bootstrap") {
            return { error: undefined, status: 0, stderr: "" };
          }
          return { error: undefined, status: 1, stdout: "" };
        });

        const result = triggerOpenClawRestart();

        expect(result).toEqual({
          ok: true,
          method: "launchctl",
          tried: [
            `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
            `launchctl bootstrap gui/${uid} /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist`,
          ],
        });
      },
    );
  });

  it("continues when launchctl bootstrap reports the service is already loaded", () => {
    setPlatform("darwin");
    withEnv(
      { VITEST: undefined, NODE_ENV: undefined, HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
      () => {
        const uid = typeof process.getuid === "function" ? process.getuid() : 501;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
          if (command === "/usr/sbin/lsof") {
            return { error: undefined, status: 1, stdout: "" };
          }
          if (command === "launchctl" && args[0] === "kickstart" && args[1] === "-k") {
            return { error: undefined, status: 113, stderr: "service not loaded" };
          }
          if (command === "launchctl" && args[0] === "bootstrap") {
            return { error: undefined, status: 37, stderr: "Operation already in progress" };
          }
          if (command === "launchctl" && args[0] === "kickstart") {
            return { error: undefined, status: 0, stdout: "" };
          }
          return { error: undefined, status: 1, stdout: "" };
        });

        const result = triggerOpenClawRestart();

        expect(result).toEqual({
          ok: true,
          method: "launchctl",
          tried: [
            `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
            `launchctl bootstrap gui/${uid} /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist`,
            `launchctl kickstart gui/${uid}/ai.openclaw.gateway`,
          ],
        });
      },
    );
  });
});
