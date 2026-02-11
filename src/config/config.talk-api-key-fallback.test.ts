import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "./test-helpers.js";

describe("talk api key fallback", () => {
  let previousEnv: string | undefined;
  let previousLoadShellEnv: string | undefined;
  let previousDeferShellEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;

    // This test relies on shell-env fallback (reading login shell env) being enabled.
    // Under the Vitest threads pool, process.env is shared across workers and other
    // tests may toggle these flags.
    previousLoadShellEnv = process.env.OPENCLAW_LOAD_SHELL_ENV;
    previousDeferShellEnv = process.env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK;
    process.env.OPENCLAW_LOAD_SHELL_ENV = "1";
    delete process.env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK;
  });

  afterEach(() => {
    process.env.ELEVENLABS_API_KEY = previousEnv;
    if (previousLoadShellEnv === undefined) {
      delete process.env.OPENCLAW_LOAD_SHELL_ENV;
    } else {
      process.env.OPENCLAW_LOAD_SHELL_ENV = previousLoadShellEnv;
    }
    if (previousDeferShellEnv === undefined) {
      delete process.env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK;
    } else {
      process.env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK = previousDeferShellEnv;
    }
  });

  it("injects talk.apiKey from profile when config is missing", async () => {
    await withTempHome(async (home) => {
      await fs.writeFile(
        path.join(home, ".profile"),
        "export ELEVENLABS_API_KEY=profile-key\n",
        "utf-8",
      );

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.config?.talk?.apiKey).toBe("profile-key");
      expect(snap.exists).toBe(false);
    });
  });

  it("prefers ELEVENLABS_API_KEY env over profile", async () => {
    await withTempHome(async (home) => {
      await fs.writeFile(
        path.join(home, ".profile"),
        "export ELEVENLABS_API_KEY=profile-key\n",
        "utf-8",
      );
      process.env.ELEVENLABS_API_KEY = "env-key";

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.config?.talk?.apiKey).toBe("env-key");
    });
  });
});
