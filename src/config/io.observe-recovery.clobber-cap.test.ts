import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
  type ObserveRecoveryDeps,
} from "./io.observe-recovery.js";

// Regression guard for the config-watcher clobber loop: when anomaly detection
// misfires in a tight loop (e.g. something external keeps stripping meta from
// the config file faster than the watcher can re-stamp it), the per-path cap
// must stop at MAX_CLOBBER_FILES_PER_PATH = 32 instead of filling the volume
// with hundreds of thousands of .clobbered.* files.
describe("config clobber snapshot cap", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fsp.mkdir(home, { recursive: true });
    return await fn(home);
  }

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-config-clobber-cap-"));
  });

  afterAll(async () => {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  function makeDeps(home: string): {
    deps: ObserveRecoveryDeps;
    configPath: string;
    warn: ReturnType<typeof vi.fn>;
  } {
    const warn = vi.fn();
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      deps: {
        fs,
        json5: JSON5,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn },
      },
      configPath,
      warn,
    };
  }

  async function seedGoodConfigAndBackup(configPath: string): Promise<void> {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    const good = {
      update: { channel: "beta" },
      gateway: { mode: "local", auth: { mode: "token", token: "secret-token" } },
      channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
    };
    await fsp.writeFile(configPath, `${JSON.stringify(good, null, 2)}\n`, "utf-8");
    await fsp.copyFile(configPath, `${configPath}.bak`);
  }

  async function writeSuspiciousRaw(
    configPath: string,
    id: number,
  ): Promise<{ raw: string; parsed: unknown }> {
    // Each write uses a different value so the hash differs, bypassing the
    // existing per-signature dedup (which is keyed on hash + reasons). This
    // simulates the real-world loop where the hash keeps drifting.
    const parsed = { update: { channel: `beta-${id}` } };
    const raw = `${JSON.stringify(parsed, null, 2)}\n`;
    await fsp.writeFile(configPath, raw, "utf-8");
    return { raw, parsed };
  }

  it("caps async clobber snapshots at MAX_CLOBBER_FILES_PER_PATH (32)", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      await seedGoodConfigAndBackup(configPath);

      // Attempt 50 distinct suspicious reads — well past the cap.
      for (let i = 0; i < 50; i += 1) {
        const { raw, parsed } = await writeSuspiciousRaw(configPath, i);
        await maybeRecoverSuspiciousConfigRead({ deps, configPath, raw, parsed });
      }

      const dirEntries = await fsp.readdir(path.dirname(configPath));
      const clobbered = dirEntries.filter((name) => name.startsWith("openclaw.json.clobbered."));
      expect(clobbered.length).toBeLessThanOrEqual(32);
      expect(clobbered.length).toBeGreaterThan(0);

      const capWarning = warn.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("clobber snapshot cap reached"),
      );
      expect(capWarning).toBeTruthy();
    });
  });

  it("caps sync clobber snapshots at MAX_CLOBBER_FILES_PER_PATH (32)", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      await seedGoodConfigAndBackup(configPath);

      for (let i = 0; i < 50; i += 1) {
        const { raw, parsed } = await writeSuspiciousRaw(configPath, i);
        maybeRecoverSuspiciousConfigReadSync({ deps, configPath, raw, parsed });
      }

      const dirEntries = await fsp.readdir(path.dirname(configPath));
      const clobbered = dirEntries.filter((name) => name.startsWith("openclaw.json.clobbered."));
      expect(clobbered.length).toBeLessThanOrEqual(32);
      expect(clobbered.length).toBeGreaterThan(0);

      const capWarning = warn.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("clobber snapshot cap reached"),
      );
      expect(capWarning).toBeTruthy();
    });
  });
});
