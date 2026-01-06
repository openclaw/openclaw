import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("web logout", () => {
  const origHomedir = os.homedir;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-logout-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    vi.resetModules();
    vi.doMock("../utils.js", async () => {
      const actual =
        await vi.importActual<typeof import("../utils.js")>("../utils.js");
      return {
        ...actual,
        CONFIG_DIR: path.join(tmpDir, ".clawdbot"),
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock("../utils.js");
    await fsPromises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {});
    // restore for safety
    // eslint-disable-next-line @typescript-eslint/unbound-method
    (os.homedir as unknown as typeof origHomedir) = origHomedir;
  });

  it(
    "deletes cached credentials when present",
    { timeout: 15_000 },
    async () => {
      const { logoutWeb, WA_WEB_AUTH_DIR } = await import("./session.js");

      expect(WA_WEB_AUTH_DIR.startsWith(tmpDir)).toBe(true);
      fs.mkdirSync(WA_WEB_AUTH_DIR, { recursive: true });
      fs.writeFileSync(path.join(WA_WEB_AUTH_DIR, "creds.json"), "{}");
      const result = await logoutWeb({ runtime: runtime as never });

      expect(result).toBe(true);
      expect(fs.existsSync(WA_WEB_AUTH_DIR)).toBe(false);
    },
  );

  it("no-ops when nothing to delete", { timeout: 15_000 }, async () => {
    const { logoutWeb } = await import("./session.js");
    const result = await logoutWeb({ runtime: runtime as never });
    expect(result).toBe(false);
    expect(runtime.log).toHaveBeenCalled();
  });

  it("keeps shared oauth.json when using legacy auth dir", async () => {
    const { logoutWeb } = await import("./session.js");
    const credsDir = path.join(tmpDir, ".clawdbot", "credentials");
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
