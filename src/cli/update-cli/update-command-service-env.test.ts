import { afterEach, expect, it, vi } from "vitest";
import {
  clearFsSafeEnvFallback,
  fsSafeEnvInput,
  normalizeFsSafeNativeEnv,
} from "../../infra/fs-safe-env.js";
import {
  withOwnedManagedUpdateEnv,
  withUpdateEnv,
  withUpdateInProgressEnv,
} from "./update-command-service-env.js";

afterEach(() => {
  clearFsSafeEnvFallback(process.env);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

it("keeps derived legacy modes below native update overrides and restores their provenance", async () => {
  vi.stubEnv("FS_SAFE_NATIVE_MODE", undefined);
  vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", undefined);
  vi.stubEnv("FS_SAFE_PYTHON_MODE", "require");
  vi.stubEnv("OPENCLAW_FS_SAFE_PYTHON_MODE", undefined);
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  normalizeFsSafeNativeEnv();
  await withUpdateEnv({ OPENCLAW_FS_SAFE_NATIVE_MODE: "off" }, async () => {
    expect(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("off");
  });
  expect(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("require");
  expect(fsSafeEnvInput(process.env).OPENCLAW_FS_SAFE_NATIVE_MODE).toBeUndefined();
  await withOwnedManagedUpdateEnv({ FS_SAFE_PYTHON_MODE: "off" }, async () => {
    expect(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("off");
  });
  expect(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("require");
  delete process.env.FS_SAFE_PYTHON_MODE;
  normalizeFsSafeNativeEnv();
  expect(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBeUndefined();
});

it.skipIf(process.platform !== "win32")(
  "restores differently cased Windows selectors after an update with a legacy native mode",
  async () => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", undefined);
    vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", undefined);
    vi.stubEnv("FS_SAFE_PYTHON_MODE", "require");
    vi.stubEnv("OPENCLAW_FS_SAFE_PYTHON_MODE", undefined);
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("openclaw_state_dir", "./previous-state");
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    normalizeFsSafeNativeEnv();

    await withUpdateInProgressEnv("C:\\update-fixture", async () => {
      expect(process.env.OPENCLAW_STATE_DIR).toBe("C:\\update-fixture\\previous-state");
      expect(process.env.OPENCLAW_FS_SAFE_NATIVE_MODE).toBe("require");
    });

    expect(process.env.OPENCLAW_STATE_DIR).toBe("./previous-state");
    expect(process.env.openclaw_state_dir).toBe("./previous-state");
    expect(fsSafeEnvInput(process.env).OPENCLAW_FS_SAFE_NATIVE_MODE).toBeUndefined();
  },
);
