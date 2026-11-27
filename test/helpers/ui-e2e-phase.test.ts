import { writeSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { beginUiE2ePhase } from "./ui-e2e-phase.js";

vi.mock("node:fs", () => ({ writeSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(writeSync).mockReset();
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
