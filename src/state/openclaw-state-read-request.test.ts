import { expect, it, vi } from "vitest";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { requestBytes } from "./openclaw-state-read-request.js";
import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";

it("refuses oversized selectors before preparation, including extra fields on type-only commands", async () => {
  const keys = Array.from({ length: 4096 }, (_, index) => `session-${index}-${"x".repeat(64)}`);
  const commands = [
    { type: "sessionRows.sharedFacts" as const, entries: [{ acp: { keys } }] },
    { type: "subagents.sessionList" as const, keys },
  ];
  const pool = new WorkerTaskPool({
    workerUrl: new URL("file:///synthetic-unstarted-worker.js"),
    maxPendingBytes: 32 * 1024,
  });
  const prepare = vi.fn(() => "must not prepare");
  try {
    for (const command of commands) {
      const inputBytes = requestBytes({
        context: { environment: { OPENCLAW_STATE_DIR: "/s" } },
        databasePath: "/s/db",
        location: "/s/db",
        checkFreshAdmission: false,
        command,
      });
      expect(inputBytes).toBeGreaterThanOrEqual(4096 * 64);
      await expect(pool.run(prepare, { inputBytes })).rejects.toMatchObject({ code: "overloaded" });
    }
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    await pool.close();
  }
});

it("preserves admission charges for every UTF-16 code unit and surrogate boundary", () => {
  const request: OpenClawStateReadRequest = {
    context: { environment: { OPENCLAW_STATE_DIR: "/s" } },
    databasePath: "/s/db",
    location: "/s/db",
    checkFreshAdmission: false,
    command: { type: "machineState.read", input: { key: "" } },
  };
  const check = (key: string) => {
    request.command = { type: "machineState.read", input: { key } };
    // Field names, slots, type, environment and paths contribute 85 bytes.
    expect(requestBytes(request)).toBe(85 + Buffer.byteLength(JSON.stringify(key)));
  };
  for (let code = 0; code <= 0xffff; code++) {
    check(String.fromCharCode(code));
  }
  for (const key of [
    "",
    "plain ASCII",
    '"\\\b\t\n\f\r\u0000',
    "中🦞",
    "\ud800\ud800",
    "\udfff\udfff",
    "\udfff\ud800",
    "\ud800\udfff",
    "\udbff\udc00",
    "\ud800x\udfff",
  ]) {
    check(key);
  }
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    requestBytes(request);
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});

it("reuses readonly engine charges across interleaved contexts while measuring changed environments", () => {
  const engines = {
    state: "sqlite",
    agent: "sqlite",
    workboard: "sqlite",
    logbook: "sqlite",
    "team-reports": "sqlite",
    quarantine: "sqlite",
    "managed-update": "sqlite",
    "package-activation": "sqlite",
  } as const;
  const readEngines = vi.fn(() => engines);
  const selection = Object.freeze({
    get effectiveEngines() {
      return readEngines();
    },
  });
  const otherEngines = vi.fn(() => ({ ...engines, state: "postgres" as const }));
  const otherSelection = Object.freeze({
    get effectiveEngines() {
      return otherEngines();
    },
  });
  const request: OpenClawStateReadRequest = {
    context: { databaseEngineSelection: selection, environment: { OPENCLAW_STATE_DIR: "/s" } },
    databasePath: "/s/db",
    location: "/s/db",
    checkFreshAdmission: false,
    command: { type: "machineState.read", input: { key: "key" } },
  };
  // The existing request costs 90 bytes; the eight SQLite family selections cost 232.
  expect(requestBytes(request)).toBe(322);
  expect(
    requestBytes({
      ...request,
      context: { ...request.context, databaseEngineSelection: otherSelection },
    }),
  ).toBe(324);
  request.context = { ...request.context, environment: { OPENCLAW_STATE_DIR: "/s", MORE: "中" } };
  expect(requestBytes(request)).toBe(329);
  request.context.environment = { OPENCLAW_STATE_DIR: "/s", MORE: "中🦞" };
  expect(requestBytes(request)).toBe(333);
  expect(
    requestBytes({
      ...request,
      context: { ...request.context, databaseEngineSelection: otherSelection },
    }),
  ).toBe(335);
  expect(readEngines).toHaveBeenCalledOnce();
  expect(otherEngines).toHaveBeenCalledOnce();

  // Offline porting replaces the families on its existing task-scoped holder.
  request.context.databaseEngineSelection = { effectiveEngines: engines };
  expect(requestBytes(request)).toBe(333);
  Object.assign(request.context.databaseEngineSelection, {
    effectiveEngines: Object.freeze({ ...engines, state: "postgres" }),
  });
  expect(requestBytes(request)).toBe(335);
});
