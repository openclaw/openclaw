import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applySoulEvilOverride, decideSoulEvil, DEFAULT_SOUL_EVIL_FILENAME } from "./soul-evil.js";
import { DEFAULT_SOUL_FILENAME, type WorkspaceBootstrapFile } from "../agents/workspace.js";

const makeFiles = (overrides?: Partial<WorkspaceBootstrapFile>) => [
  {
    name: DEFAULT_SOUL_FILENAME,
    path: "/tmp/SOUL.md",
    content: "friendly",
    missing: false,
    ...overrides,
  },
];

describe("decideSoulEvil", () => {
  it("returns false when no config", () => {
    const result = decideSoulEvil({});
    expect(result.useEvil).toBe(false);
  });

  it("activates on random chance", () => {
    const result = decideSoulEvil({
      config: { chance: 0.5 },
      random: () => 0.2,
    });
    expect(result.useEvil).toBe(true);
    expect(result.reason).toBe("chance");
  });

  it("activates during purge window", () => {
    const result = decideSoulEvil({
      config: {
        purge: { at: "00:00", duration: "10m" },
      },
      userTimezone: "UTC",
      now: new Date("2026-01-01T00:05:00Z"),
    });
    expect(result.useEvil).toBe(true);
    expect(result.reason).toBe("purge");
  });

  it("prefers purge window over random chance", () => {
    const result = decideSoulEvil({
      config: {
        chance: 0,
        purge: { at: "00:00", duration: "10m" },
      },
      userTimezone: "UTC",
      now: new Date("2026-01-01T00:05:00Z"),
      random: () => 0,
    });
    expect(result.useEvil).toBe(true);
    expect(result.reason).toBe("purge");
  });

  it("skips purge window when outside duration", () => {
    const result = decideSoulEvil({
      config: {
        purge: { at: "00:00", duration: "10m" },
      },
      userTimezone: "UTC",
      now: new Date("2026-01-01T00:30:00Z"),
    });
    expect(result.useEvil).toBe(false);
  });

  it("honors sub-minute purge durations", () => {
    const config = {
      purge: { at: "00:00", duration: "30s" },
    };
    const active = decideSoulEvil({
      config,
      userTimezone: "UTC",
      now: new Date("2026-01-01T00:00:20Z"),
    });
    const inactive = decideSoulEvil({
      config,
      userTimezone: "UTC",
      now: new Date("2026-01-01T00:00:40Z"),
    });
    expect(active.useEvil).toBe(true);
    expect(active.reason).toBe("purge");
    expect(inactive.useEvil).toBe(false);
  });
});

describe("applySoulEvilOverride", () => {
  it("replaces SOUL content when evil is active and file exists", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-soul-"));
    const evilPath = path.join(tempDir, DEFAULT_SOUL_EVIL_FILENAME);
    await fs.writeFile(evilPath, "chaotic", "utf-8");

    const files = makeFiles({
      path: path.join(tempDir, DEFAULT_SOUL_FILENAME),
    });

    const updated = await applySoulEvilOverride({
      files,
      workspaceDir: tempDir,
      config: { chance: 1 },
      userTimezone: "UTC",
      random: () => 0,
    });

    const soul = updated.find((file) => file.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.content).toBe("chaotic");
  });

  it("leaves SOUL content when evil file is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-soul-"));
    const files = makeFiles({
      path: path.join(tempDir, DEFAULT_SOUL_FILENAME),
    });

    const updated = await applySoulEvilOverride({
      files,
      workspaceDir: tempDir,
      config: { chance: 1 },
      userTimezone: "UTC",
      random: () => 0,
    });

    const soul = updated.find((file) => file.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.content).toBe("friendly");
  });
});
