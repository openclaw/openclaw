import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";

describe("config io observe", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fs.mkdir(home, { recursive: true });
    return await fn(home);
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-observe-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function makeIo(home: string, warn = vi.fn(), error = vi.fn()) {
    const io = createConfigIO({
      env: {} as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: {
        warn,
        error,
      },
    });
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
    return { io, configPath, auditPath, warn, error };
  }

  it("records forensic audit for suspicious out-of-band config clobbers", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, auditPath, warn } = await makeIo(home);

      await io.writeConfigFile({
        update: { channel: "beta" },
        browser: { enabled: true },
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "secret-token" },
        },
        channels: {
          discord: {
            enabled: true,
            dmPolicy: "pairing",
          },
        },
      });

      const seeded = await io.readConfigFileSnapshot();
      expect(seeded.valid).toBe(true);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fs.writeFile(configPath, clobberedRaw, "utf-8");

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.update?.channel).toBe("beta");
      expect(snapshot.config.gateway?.mode).toBeUndefined();

      const lines = (await fs.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observe = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "config.observe")
        .at(-1);

      expect(observe).toBeDefined();
      expect(observe?.source).toBe("config-io");
      expect(observe?.configPath).toBe(configPath);
      expect(observe?.valid).toBe(true);
      expect(observe?.suspicious).toEqual(
        expect.arrayContaining(["gateway-mode-missing-vs-last-good", "update-channel-only-root"]),
      );
      expect(observe?.clobberedPath).toBeTypeOf("string");
      await expect(fs.readFile(String(observe?.clobberedPath), "utf-8")).resolves.toBe(
        clobberedRaw,
      );

      const anomalyLog = warn.mock.calls
        .map((call) => call[0])
        .find((entry) => typeof entry === "string" && entry.startsWith("Config observe anomaly:"));
      expect(anomalyLog).toContain(configPath);
    });
  });

  it("does not duplicate forensic audit for repeated reads of the same suspicious hash", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, auditPath } = await makeIo(home);

      await io.writeConfigFile({
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            dmPolicy: "pairing",
            groupPolicy: "allowlist",
          },
        },
      });
      await io.readConfigFileSnapshot();

      await fs.writeFile(
        configPath,
        `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`,
        "utf-8",
      );

      await io.readConfigFileSnapshot();
      await io.readConfigFileSnapshot();

      const lines = (await fs.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observeEvents = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "config.observe");

      expect(observeEvents).toHaveLength(1);
    });
  });

  it("records forensic audit from loadConfig when only the backup file provides the baseline", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, auditPath, warn } = await makeIo(home);

      await io.writeConfigFile({
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            dmPolicy: "pairing",
            groupPolicy: "allowlist",
          },
        },
      });
      await fs.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fs.writeFile(configPath, clobberedRaw, "utf-8");

      const loaded = io.loadConfig();
      expect(loaded.gateway?.mode).toBeUndefined();

      const lines = (await fs.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observe = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "config.observe")
        .at(-1);

      expect(observe).toBeDefined();
      expect(observe?.backupHash).toBeTypeOf("string");
      expect(observe?.suspicious).toEqual(
        expect.arrayContaining(["gateway-mode-missing-vs-last-good", "update-channel-only-root"]),
      );

      const anomalyLog = warn.mock.calls
        .map((call) => call[0])
        .find((entry) => typeof entry === "string" && entry.startsWith("Config observe anomaly:"));
      expect(anomalyLog).toContain(configPath);
    });
  });
});
