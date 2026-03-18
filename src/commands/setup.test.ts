import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { setupCommand } from "./setup.js";

describe("setupCommand", () => {
  const expectPrivateDirMode = (actual: number) => {
    if (process.platform === "win32") {
      expect([0o700, 0o666, 0o777]).toContain(actual);
      return;
    }
    expect(actual).toBe(0o700);
  };

  it("writes gateway.mode=local on first run", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await setupCommand(undefined, runtime);

      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const raw = await fs.readFile(configPath, "utf-8");
      const sessionsDir = path.join(home, ".openclaw", "agents", "main", "sessions");
      const sessionsMode = (await fs.stat(sessionsDir)).mode & 0o777;

      expect(raw).toContain('"mode": "local"');
      expect(raw).toContain('"workspace"');
      expectPrivateDirMode(sessionsMode);
    });
  });

  it("adds gateway.mode=local to an existing config without overwriting workspace", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const workspace = path.join(home, "custom-workspace");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace,
            },
          },
        }),
      );

      await setupCommand(undefined, runtime);

      const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { defaults?: { workspace?: string } };
        gateway?: { mode?: string };
      };

      expect(raw.agents?.defaults?.workspace).toBe(workspace);
      expect(raw.gateway?.mode).toBe("local");
    });
  });

  it("bootstraps a configured managed session.store template instead of the default sessions dir", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const managedSessionsDir = path.join(home, "managed-sessions", "main");
      const managedStore = path.join(home, "managed-sessions", "{agentId}", "sessions.json");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          session: {
            store: managedStore,
          },
        }),
      );

      await setupCommand(undefined, runtime);

      const sessionsMode = (await fs.stat(managedSessionsDir)).mode & 0o777;

      expectPrivateDirMode(sessionsMode);
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("managed-sessions/main"));
    });
  });

  it("does not tighten arbitrary custom session.store parent directories", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const customDir = path.join(home, "custom-store-root");
      const customStore = path.join(customDir, "sessions-{agentId}.json");

      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(customDir, { recursive: true, mode: 0o755 });
      await fs.chmod(customDir, 0o755);
      await fs.writeFile(
        configPath,
        JSON.stringify({
          session: {
            store: customStore,
          },
        }),
      );

      await setupCommand(undefined, runtime);

      const mode = (await fs.stat(customDir)).mode & 0o777;
      expect(mode).toBe(0o755);
    });
  });
});
