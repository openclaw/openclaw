import { writeSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { beginUiE2ePhase } from "./ui-e2e-phase.js";

vi.mock("node:fs", () => ({ writeSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(writeSync).mockReset();
});

it("records setup entry while the owner is still pending, then preserves its result", async () => {
  vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", "synthetic-diagnostics");
  const pending = Promise.withResolvers<string>();
  const finishPhase = beginUiE2ePhase("fresh-visit-state-create", true);
  const result = pending.promise.finally(finishPhase);
  const beforeSettlement = vi.mocked(writeSync).mock.calls.map(([, line]) => line);

  pending.resolve("ready");
  await expect(result).resolves.toBe("ready");

  expect(beforeSettlement).toHaveLength(1);
  expect(beforeSettlement[0]).toMatch(/^\[control-ui-e2e-setup-start\] /);
  const start = JSON.parse(beforeSettlement[0]!.split("] ")[1]!);
  expect(start).toEqual({
    phase: "fresh-visit-state-create",
    pid: process.pid,
    startMs: expect.any(Number),
  });
  expect(writeSync).toHaveBeenCalledTimes(2);
  const completion = vi.mocked(writeSync).mock.calls[1]![1];
  expect(completion).toMatch(/^\[control-ui-e2e-phase\] /);
  expect(JSON.parse(completion.split("] ")[1]!)).toEqual({
    ...start,
    endMs: expect.any(Number),
  });
});

it.each([undefined, "", "   "])("does not write setup records with diagnostics %j", (directory) => {
  vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", directory);
  beginUiE2ePhase("suite-setup", true)();
  expect(writeSync).not.toHaveBeenCalled();
});

it("keeps existing phases completion-only by default", () => {
  vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", "synthetic-diagnostics");
  const finishPhase = beginUiE2ePhase("suite-setup");
  expect(writeSync).not.toHaveBeenCalled();
  finishPhase();
  expect(writeSync).toHaveBeenCalledOnce();
  const completion = vi.mocked(writeSync).mock.calls[0]![1];
  expect(completion).toMatch(/^\[control-ui-e2e-phase\] /);
  expect(JSON.parse(completion.split("] ")[1]!)).toEqual({
    phase: "suite-setup",
    pid: process.pid,
    startMs: expect.any(Number),
    endMs: expect.any(Number),
  });
});

it.each([0, 1])("preserves the owner rejection when setup write %i fails", async (failedWrite) => {
  vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", "synthetic-diagnostics");
  let writes = 0;
  vi.mocked(writeSync).mockImplementation(() => {
    if (writes++ === failedWrite) {
      throw new Error("diagnostic pipe closed");
    }
    return 0;
  });
  const failure = new Error("owned setup failed");
  const finishPhase = beginUiE2ePhase("suite-setup", true);

  await expect(Promise.reject(failure).finally(finishPhase)).rejects.toBe(failure);
  expect(writeSync).toHaveBeenCalledTimes(2);
});

it("preserves the owner failure when its completed timing cannot be written", async () => {
  vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", "synthetic-diagnostics");
  vi.mocked(writeSync).mockImplementation(() => {
    throw new Error("diagnostic pipe closed");
  });
  const failure = new Error("owned cleanup failed");
  const finishPhase = beginUiE2ePhase("gateway-cleanup");

  await expect(Promise.reject(failure).finally(finishPhase)).rejects.toBe(failure);
  expect(writeSync).toHaveBeenCalledOnce();
});
