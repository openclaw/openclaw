import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isPathWithinBase } from "../../test/helpers/paths.js";
import { withTempHome } from "../../test/helpers/temp-home.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("web logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes cached credentials when present", { timeout: 60_000 }, async () => {
    await withTempHome(async (home) => {
      const { logoutWeb } = await import("./session.js");
      const { resolveDefaultWebAuthDir } = await import("./auth-store.js");
      const authDir = resolveDefaultWebAuthDir();

      expect(isPathWithinBase(home, authDir)).toBe(true);

      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, "creds.json"), "{}");
      const result = await logoutWeb({ runtime: runtime as never });

      expect(result).toBe(true);
      expect(fs.existsSync(authDir)).toBe(false);
    });
  });

  it("no-ops when nothing to delete", { timeout: 60_000 }, async () => {
    await withTempHome(async () => {
      const { logoutWeb } = await import("./session.js");
      const result = await logoutWeb({ runtime: runtime as never });
      expect(result).toBe(false);
      expect(runtime.log).toHaveBeenCalled();
    });
  });

  it("keeps shared oauth.json when using legacy auth dir", async () => {
    await withTempHome(async () => {
      const { logoutWeb } = await import("./session.js");

      const { resolveOAuthDir } = await import("../config/paths.js");
      const credsDir = resolveOAuthDir();

      fs.mkdirSync(credsDir, { recursive: true });
      fs.writeFileSync(path.join(credsDir, "creds.json"), "{}");
      fs.writeFileSync(path.join(credsDir, "oauth.json"), '{"token":true}');
      fs.writeFileSync(path.join(credsDir, "session-abc.json"), "{}");

      const result = await logoutWeb({
        authDir: credsDir,
        isLegacyAuthDir: true,
        runtime: runtime as never,
      });
      expect(result).toBe(true);
      expect(fs.existsSync(path.join(credsDir, "oauth.json"))).toBe(true);
      expect(fs.existsSync(path.join(credsDir, "creds.json"))).toBe(false);
      expect(fs.existsSync(path.join(credsDir, "session-abc.json"))).toBe(false);
    });
  });
});
