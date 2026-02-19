import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { PolicyBlockedError } from "./policy-gates.js";
import { PluginManagerMvp, checkPluginCompatibility } from "./plugin-manager.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-phase4-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("PluginManagerMvp", () => {
  it("enables and disables plugins with lifecycle config updates", () => {
    const manager = new PluginManagerMvp({ platformVersion: "2026.2.13" });
    const cfg = {} as OpenClawConfig;

    const enabled = manager.enable({ cfg, pluginId: "demo", actorRole: "admin" });
    expect(enabled.enabled).toBe(true);
    expect(enabled.config.plugins?.entries?.demo?.enabled).toBe(true);

    const disabled = manager.disable({ cfg: enabled.config, pluginId: "demo", actorRole: "admin" });
    expect(disabled.disabled).toBe(true);
    expect(disabled.config.plugins?.entries?.demo?.enabled).toBe(false);
  });

  it("checks compatibility against platform contract/version", () => {
    const compat = checkPluginCompatibility(
      {
        idHint: "demo",
        source: "/x/index.ts",
        rootDir: "/x",
        origin: "config",
        packageManifest: {
          platformContract: "openclaw.plugin-api",
          platformMinVersion: "2026.2.10",
        },
      },
      "2026.2.13",
    );
    expect(compat.ok).toBe(true);

    const incompatible = checkPluginCompatibility(
      {
        idHint: "demo",
        source: "/x/index.ts",
        rootDir: "/x",
        origin: "config",
        packageManifest: {
          platformContract: "other.contract",
          platformMinVersion: "2027.1.0",
        },
      },
      "2026.2.13",
    );
    expect(incompatible.ok).toBe(false);
    expect(incompatible.reasons.join(" ")).toContain("Unsupported platform contract");
  });

  it("blocks high-risk actions without role and writes audit events", () => {
    const dir = makeTempDir();
    const auditFilePath = path.join(dir, "audit", "orchestration.jsonl");
    const manager = new PluginManagerMvp({ platformVersion: "2026.2.13", auditFilePath });

    expect(() => manager.enable({ cfg: {} as OpenClawConfig, pluginId: "demo", actorRole: "viewer" })).toThrow(
      PolicyBlockedError,
    );

    const lines = fs.readFileSync(auditFilePath, "utf-8").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line) as { type: string; reason?: string });
    expect(events.some((event) => event.type === "policy.blocked")).toBe(true);
    expect(events[0]?.reason).toContain("blocked by policy");
  });
});
