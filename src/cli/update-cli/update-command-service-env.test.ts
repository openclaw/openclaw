import { afterEach, expect, it, vi } from "vitest";
import { withUpdateEnv } from "./update-command-service-env.js";

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("restores only update phase overrides after failure=%s", async (fails) => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "previous");
  vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "inherited");
  vi.stubEnv("OPENCLAW_UPDATE_TEST_OTHER", "before");
  vi.stubEnv("OPENCLAW_UPDATE_TEST_NEW", undefined);
  const failure = new Error("phase failed");
  const run = withUpdateEnv(
    {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
      OPENCLAW_UPDATE_TEST_NEW: "created",
    },
    async () => {
      expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
      expect(process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBeUndefined();
      expect(process.env.OPENCLAW_UPDATE_TEST_NEW).toBe("created");
      process.env.OPENCLAW_UPDATE_TEST_OTHER = "phase-owned";
      if (fails) {
        throw failure;
      }
      return "completed";
    },
  );
  if (fails) {
    await expect(run).rejects.toBe(failure);
  } else {
    await expect(run).resolves.toBe("completed");
  }
  expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe("previous");
  expect(process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBe("inherited");
  expect(process.env.OPENCLAW_UPDATE_TEST_NEW).toBeUndefined();
  expect(process.env.OPENCLAW_UPDATE_TEST_OTHER).toBe("phase-owned");
});
