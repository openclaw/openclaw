// Home isolation tests validate HOME, state directory, and outbound telemetry isolation.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../src/config/config.js";
import { buildUpdateResultPayload } from "../src/infra/update-result-payload.js";
import { sendUpdateResultTelemetry } from "../src/infra/update-result-telemetry.js";

describe("shared test setup home isolation", () => {
  it("routes default config IO through the per-worker temp home", () => {
    const testHome = process.env.OPENCLAW_TEST_HOME;
    if (!testHome) {
      throw new Error("OPENCLAW_TEST_HOME must be set by the test setup");
    }
    expect(process.env.HOME).toBe(testHome);
    expect(process.env.USERPROFILE).toBe(testHome);
    expect(createConfigIO().configPath).toBe(path.join(testHome, ".openclaw", "openclaw.json"));
  });

  it("keeps update reports off the production receiver when a case emulates production", async () => {
    // Clearing the runner markers disables the sender's own test guard, as some suites do.
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", "production");
    const requests = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      const payload = buildUpdateResultPayload({
        runId: "isolation-fixture",
        createdAtMs: 0,
        updatedAtMs: 1,
        trigger: "cli",
        phase: "finished",
        status: "failed",
        reason: null,
        origin: {},
        target: {},
        before: {},
        after: {},
        steps: [],
        verification: {},
        repair: [],
        confirmedAtMs: null,
        finishedAtMs: 1,
        downtimeMs: null,
      });
      // CI suppression is cleared so the policy allows sending, as on a developer machine.
      await sendUpdateResultTelemetry(payload!, { env: { ...process.env, CI: undefined } });
      const hosts = requests.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : input.toString()).hostname,
      );
      expect(hosts.length).toBeGreaterThan(0);
      expect(hosts.every((host) => host === "127.0.0.1")).toBe(true);
    } finally {
      requests.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
