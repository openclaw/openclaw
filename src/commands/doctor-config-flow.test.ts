import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { loadAndMaybeMigrateDoctorConfig, renameStaleLegacyConfigs } from "./doctor-config-flow.js";

describe("doctor config flow", () => {
  it("preserves invalid config for doctor repairs", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            gateway: { auth: { mode: "token", token: 123 } },
            agents: { list: [{ id: "pi" }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true },
        confirm: async () => false,
      });

      expect((result.cfg as Record<string, unknown>).gateway).toEqual({
        auth: { mode: "token", token: 123 },
      });
    });
  });

  it("drops unknown keys on repair", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            bridge: { bind: "auto" },
            gateway: { auth: { mode: "token", token: "ok", extra: true } },
            agents: { list: [{ id: "pi" }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => true,
      });

      expect((result.cfg as Record<string, unknown>).bridge).toBeUndefined();
    });
  });
});

describe("renameStaleLegacyConfigs", () => {
  it("renames stale legacy configs when openclaw.json exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-stale-"));
    try {
      await fs.writeFile(path.join(root, "openclaw.json"), "{}", "utf-8");
      await fs.writeFile(path.join(root, "clawdbot.json"), "{}", "utf-8");
      await fs.writeFile(path.join(root, "moltbot.json"), "{}", "utf-8");

      const changes = await renameStaleLegacyConfigs(root);
      expect(changes).toHaveLength(2);
      expect(changes[0]).toContain("clawdbot.json");
      expect(changes[1]).toContain("moltbot.json");

      const files = await fs.readdir(root);
      expect(files).toContain("openclaw.json");
      expect(files).toContain("clawdbot.json.migrated");
      expect(files).toContain("moltbot.json.migrated");
      expect(files).not.toContain("clawdbot.json");
      expect(files).not.toContain("moltbot.json");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does nothing when openclaw.json does not exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-no-primary-"));
    try {
      await fs.writeFile(path.join(root, "clawdbot.json"), "{}", "utf-8");

      const changes = await renameStaleLegacyConfigs(root);
      expect(changes).toHaveLength(0);

      const files = await fs.readdir(root);
      expect(files).toContain("clawdbot.json");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does nothing when no legacy configs exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-clean-"));
    try {
      await fs.writeFile(path.join(root, "openclaw.json"), "{}", "utf-8");

      const changes = await renameStaleLegacyConfigs(root);
      expect(changes).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects OPENCLAW_STATE_DIR when no stateDir arg is passed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-envdir-"));
    const original = process.env.OPENCLAW_STATE_DIR;
    try {
      await fs.writeFile(path.join(root, "openclaw.json"), "{}", "utf-8");
      await fs.writeFile(path.join(root, "clawdbot.json"), "{}", "utf-8");

      process.env.OPENCLAW_STATE_DIR = root;
      const changes = await renameStaleLegacyConfigs(); // no args — should use env
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain("clawdbot.json");

      const files = await fs.readdir(root);
      expect(files).toContain("clawdbot.json.migrated");
      expect(files).not.toContain("clawdbot.json");
    } finally {
      if (original !== undefined) {
        process.env.OPENCLAW_STATE_DIR = original;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("overwrites existing .migrated file on second run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-collision-"));
    try {
      await fs.writeFile(path.join(root, "openclaw.json"), "{}", "utf-8");
      await fs.writeFile(path.join(root, "clawdbot.json"), '{"new": true}', "utf-8");
      await fs.writeFile(path.join(root, "clawdbot.json.migrated"), '{"old": true}', "utf-8");

      const changes = await renameStaleLegacyConfigs(root);
      expect(changes).toHaveLength(1);

      // .migrated should contain the new content (overwritten)
      const content = await fs.readFile(path.join(root, "clawdbot.json.migrated"), "utf-8");
      expect(content).toBe('{"new": true}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
