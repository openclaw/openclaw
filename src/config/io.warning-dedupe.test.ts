import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";

describe("config warning deduplication", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-warn-dedupe-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(home, { recursive: true });
    return fn(home);
  }

  it("logs config validation warnings only once for repeated loadConfig calls", async () => {
    await withHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      // Use a legacy removed plugin ID to trigger a validation warning
      // (not an error — removed plugins produce "stale config entry ignored" warnings).
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            gateway: { mode: "local" },
            plugins: { entries: { "google-antigravity-auth": { enabled: false } } },
          },
          null,
          2,
        ),
      );

      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });

      // First load — should log the plugin warning
      io.loadConfig();
      const warningCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Config warnings"),
      );
      expect(warningCalls.length).toBe(1);

      // Second load — same warning fingerprint, should be suppressed
      io.loadConfig();
      const warningCallsAfter = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Config warnings"),
      );
      expect(warningCallsAfter.length).toBe(1);

      // Third load — still suppressed
      io.loadConfig();
      const warningCallsFinal = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Config warnings"),
      );
      expect(warningCallsFinal.length).toBe(1);
    });
  });
});
