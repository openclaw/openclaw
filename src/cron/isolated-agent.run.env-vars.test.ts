import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("runCronIsolatedAgentTurn env vars propagation (#29886)", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("applies config env vars to process.env", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const originalEnv = process.env.TEST_API_KEY;

      const cfg = makeCfg(home, storePath, {
        env: { TEST_API_KEY: "test-key-from-config" },
      });

      let capturedEnv: Record<string, string> = {};
      vi.mocked(runEmbeddedPiAgent).mockImplementation(async () => {
        capturedEnv = { ...process.env };
        return { payloads: [{ text: "ok" }] };
      });

      await runCronIsolatedAgentTurn({ cfg, home, job: makeJob({ env: {} }) });

      expect(capturedEnv.TEST_API_KEY).toBe("test-key-from-config");

      if (originalEnv !== undefined) {
        process.env.TEST_API_KEY = originalEnv;
      } else {
        delete process.env.TEST_API_KEY;
      }
    });
  });
});
