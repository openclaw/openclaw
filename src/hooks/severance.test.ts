import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOUL_FILENAME, type WorkspaceBootstrapFile } from "../agents/workspace.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  applySeveranceOverride,
  decideSeverancePersona,
  DEFAULT_MEMORY_INNIE,
  DEFAULT_MEMORY_OUTIE,
  DEFAULT_SOUL_INNIE,
  DEFAULT_SOUL_OUTIE,
  haversineDistanceKm,
  resolveSeveranceConfigFromHook,
} from "./severance.js";

const makeFiles = (overrides?: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile[] => [
  {
    name: DEFAULT_SOUL_FILENAME,
    path: "/tmp/SOUL.md",
    content: "default soul",
    missing: false,
    ...overrides,
  },
  {
    name: "MEMORY.md",
    path: "/tmp/MEMORY.md",
    content: "default memory",
    missing: false,
  },
];

// ── resolveSeveranceConfigFromHook ─────────────────────────────────────

describe("resolveSeveranceConfigFromHook", () => {
  it("returns null for undefined entry", () => {
    expect(resolveSeveranceConfigFromHook(undefined)).toBeNull();
  });

  it("returns null for empty entry", () => {
    expect(resolveSeveranceConfigFromHook({})).toBeNull();
  });

  it("parses valid schedule activation", () => {
    const result = resolveSeveranceConfigFromHook({
      activation: {
        mode: "schedule",
        schedule: {
          workHours: { start: "09:00", end: "17:00" },
          workDays: [1, 2, 3, 4, 5],
        },
      },
    });
    expect(result).not.toBeNull();
    expect(result?.activation?.mode).toBe("schedule");
    expect(result?.activation?.schedule?.workHours?.start).toBe("09:00");
    expect(result?.activation?.schedule?.workDays).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses valid location activation", () => {
    const result = resolveSeveranceConfigFromHook({
      activation: {
        mode: "location",
        location: { lat: 40.7128, lon: -74.006, radiusKm: 0.5 },
      },
    });
    expect(result).not.toBeNull();
    expect(result?.activation?.mode).toBe("location");
    expect(result?.activation?.location?.lat).toBe(40.7128);
  });

  it("parses custom file overrides", () => {
    const result = resolveSeveranceConfigFromHook({
      activation: { mode: "manual", persona: "innie" },
      files: { soulInnie: "MY_WORK_SOUL.md", memoryInnie: "MY_WORK_MEMORY.md" },
    });
    expect(result?.files?.soulInnie).toBe("MY_WORK_SOUL.md");
    expect(result?.files?.memoryInnie).toBe("MY_WORK_MEMORY.md");
  });

  it("warns on invalid activation type", () => {
    const warnings: string[] = [];
    resolveSeveranceConfigFromHook(
      { activation: "not-an-object" },
      { warn: (msg) => warnings.push(msg) },
    );
    expect(warnings.some((m) => m.includes("activation must be an object"))).toBe(true);
  });

  it("warns on invalid mode value", () => {
    const warnings: string[] = [];
    resolveSeveranceConfigFromHook(
      { activation: { mode: "bogus" } },
      { warn: (msg) => warnings.push(msg) },
    );
    expect(warnings.some((m) => m.includes("activation.mode must be"))).toBe(true);
  });
});

// ── decideSeverancePersona ─────────────────────────────────────────────

describe("decideSeverancePersona", () => {
  it("returns null when no config", async () => {
    const result = await decideSeverancePersona({});
    expect(result).toBeNull();
  });

  it("returns null when activation has no mode", async () => {
    const result = await decideSeverancePersona({ config: { activation: {} } });
    expect(result).toBeNull();
  });

  // Schedule mode
  it("schedule: innie during work hours on weekday", async () => {
    const result = await decideSeverancePersona({
      config: {
        activation: {
          mode: "schedule",
          schedule: {
            workHours: { start: "09:00", end: "17:00" },
            workDays: [1, 2, 3, 4, 5],
          },
        },
      },
      userTimezone: "UTC",
      now: new Date("2026-01-05T12:00:00Z"), // Monday
    });
    expect(result?.persona).toBe("innie");
    expect(result?.reason).toContain("work-hours");
  });

  it("schedule: outie outside work hours on weekday", async () => {
    const result = await decideSeverancePersona({
      config: {
        activation: {
          mode: "schedule",
          schedule: {
            workHours: { start: "09:00", end: "17:00" },
            workDays: [1, 2, 3, 4, 5],
          },
        },
      },
      userTimezone: "UTC",
      now: new Date("2026-01-05T20:00:00Z"), // Monday evening
    });
    expect(result?.persona).toBe("outie");
    expect(result?.reason).toContain("off-hours");
  });

  it("schedule: outie on weekend", async () => {
    const result = await decideSeverancePersona({
      config: {
        activation: {
          mode: "schedule",
          schedule: {
            workHours: { start: "09:00", end: "17:00" },
            workDays: [1, 2, 3, 4, 5],
          },
        },
      },
      userTimezone: "UTC",
      now: new Date("2026-01-04T12:00:00Z"), // Sunday
    });
    expect(result?.persona).toBe("outie");
    expect(result?.reason).toContain("weekend");
  });

  it("schedule: respects timezone", async () => {
    // 22:00 UTC = 09:00 JST next day (but day-of-week shifts)
    // Use a time that's clearly morning in JST but evening in UTC
    const result = await decideSeverancePersona({
      config: {
        activation: {
          mode: "schedule",
          schedule: {
            workHours: { start: "09:00", end: "17:00" },
            workDays: [1, 2, 3, 4, 5],
          },
        },
      },
      userTimezone: "Asia/Tokyo",
      now: new Date("2026-01-05T01:00:00Z"), // Monday 10:00 JST
    });
    expect(result?.persona).toBe("innie");
  });

  // Channel mode
  it("channel: innie when channel matches", async () => {
    const result = await decideSeverancePersona({
      config: {
        activation: { mode: "channel", channels: { innie: ["slack", "msteams"] } },
      },
      runtimeChannel: "slack",
    });
    expect(result?.persona).toBe("innie");
  });

  it("channel: outie when channel does not match", async () => {
    const result = await decideSeverancePersona({
      config: {
        activation: { mode: "channel", channels: { innie: ["slack"] } },
      },
      runtimeChannel: "telegram",
    });
    expect(result?.persona).toBe("outie");
  });

  it("channel: outie when no channel provided", async () => {
    const result = await decideSeverancePersona({
      config: {
        activation: { mode: "channel", channels: { innie: ["slack"] } },
      },
    });
    expect(result?.persona).toBe("outie");
  });

  // Env mode
  it("env: innie when env var matches", async () => {
    const result = await decideSeverancePersona({
      config: {
        activation: { mode: "env", env: { var: "WORK_MODE", innieValue: "work" } },
      },
      env: { WORK_MODE: "work" },
    });
    expect(result?.persona).toBe("innie");
  });

  it("env: outie when env var differs", async () => {
    const result = await decideSeverancePersona({
      config: {
        activation: { mode: "env", env: { var: "WORK_MODE", innieValue: "work" } },
      },
      env: { WORK_MODE: "home" },
    });
    expect(result?.persona).toBe("outie");
  });

  // Manual mode
  it("manual: returns configured persona", async () => {
    const result = await decideSeverancePersona({
      config: { activation: { mode: "manual", persona: "innie" } },
    });
    expect(result?.persona).toBe("innie");
    expect(result?.reason).toBe("manual");
  });

  // Location mode
  it("location: innie within radius", async () => {
    const tempDir = await makeTempWorkspace("openclaw-loc-");
    const { writeNodeLocationState } = await import("../infra/node-location-state.js");
    await writeNodeLocationState(
      { lat: 40.7128, lon: -74.006, timestamp: new Date().toISOString() },
      tempDir,
    );
    const result = await decideSeverancePersona({
      config: {
        activation: {
          mode: "location",
          location: { lat: 40.7128, lon: -74.006, radiusKm: 0.5 },
        },
      },
      locationStateDir: tempDir,
    });
    expect(result?.persona).toBe("innie");
  });

  it("location: outie outside radius", async () => {
    const tempDir = await makeTempWorkspace("openclaw-loc-");
    const { writeNodeLocationState } = await import("../infra/node-location-state.js");
    await writeNodeLocationState(
      { lat: 51.5074, lon: -0.1278, timestamp: new Date().toISOString() },
      tempDir,
    );
    const result = await decideSeverancePersona({
      config: {
        activation: {
          mode: "location",
          location: { lat: 40.7128, lon: -74.006, radiusKm: 0.5 },
        },
      },
      locationStateDir: tempDir,
    });
    expect(result?.persona).toBe("outie");
  });

  it("location: outie when no location data", async () => {
    const tempDir = await makeTempWorkspace("openclaw-loc-");
    const result = await decideSeverancePersona({
      config: {
        activation: {
          mode: "location",
          location: { lat: 40.7128, lon: -74.006, radiusKm: 0.5 },
        },
      },
      locationStateDir: tempDir,
    });
    expect(result?.persona).toBe("outie");
    expect(result?.reason).toContain("no-data");
  });
});

// ── haversineDistanceKm ────────────────────────────────────────────────

describe("haversineDistanceKm", () => {
  it("returns 0 for same point", () => {
    expect(haversineDistanceKm(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
  });

  it("calculates reasonable distance between NYC and London", () => {
    const distance = haversineDistanceKm(40.7128, -74.006, 51.5074, -0.1278);
    expect(distance).toBeGreaterThan(5500);
    expect(distance).toBeLessThan(5700);
  });
});

// ── applySeveranceOverride ─────────────────────────────────────────────

describe("applySeveranceOverride", () => {
  it("replaces SOUL.md with innie content", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_SOUL_INNIE, content: "work persona" });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_MEMORY_INNIE, content: "work memory" });

    const files = makeFiles({ path: path.join(tempDir, DEFAULT_SOUL_FILENAME) });
    const updated = await applySeveranceOverride({
      files,
      workspaceDir: tempDir,
      config: { activation: { mode: "manual", persona: "innie" } },
    });

    const soul = updated.find((f) => f.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.content).toBe("work persona");
  });

  it("replaces SOUL.md with outie content", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_SOUL_OUTIE,
      content: "personal persona",
    });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_MEMORY_OUTIE,
      content: "personal memory",
    });

    const files = makeFiles({ path: path.join(tempDir, DEFAULT_SOUL_FILENAME) });
    const updated = await applySeveranceOverride({
      files,
      workspaceDir: tempDir,
      config: { activation: { mode: "manual", persona: "outie" } },
    });

    const soul = updated.find((f) => f.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.content).toBe("personal persona");
  });

  it("replaces MEMORY.md based on persona", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_SOUL_INNIE, content: "work soul" });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_MEMORY_INNIE,
      content: "work memory only",
    });

    const files = makeFiles({ path: path.join(tempDir, DEFAULT_SOUL_FILENAME) });
    const updated = await applySeveranceOverride({
      files,
      workspaceDir: tempDir,
      config: { activation: { mode: "manual", persona: "innie" } },
    });

    const memory = updated.find((f) => f.name === "MEMORY.md");
    expect(memory?.content).toBe("work memory only");
  });

  it("leaves SOUL content when persona file is missing", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-");
    const warnings: string[] = [];
    const files = makeFiles({ path: path.join(tempDir, DEFAULT_SOUL_FILENAME) });

    const updated = await applySeveranceOverride({
      files,
      workspaceDir: tempDir,
      config: { activation: { mode: "manual", persona: "innie" } },
      log: { warn: (msg) => warnings.push(msg) },
    });

    const soul = updated.find((f) => f.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.content).toBe("default soul");
    expect(warnings.some((m) => m.includes("file missing"))).toBe(true);
  });

  it("warns when persona file is empty", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_SOUL_INNIE, content: "  " });
    const warnings: string[] = [];
    const files = makeFiles({ path: path.join(tempDir, DEFAULT_SOUL_FILENAME) });

    const updated = await applySeveranceOverride({
      files,
      workspaceDir: tempDir,
      config: { activation: { mode: "manual", persona: "innie" } },
      log: { warn: (msg) => warnings.push(msg) },
    });

    const soul = updated.find((f) => f.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.content).toBe("default soul");
    expect(warnings.some((m) => m.includes("file empty"))).toBe(true);
  });

  it("uses custom filenames from config", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-");
    await writeWorkspaceFile({ dir: tempDir, name: "WORK_SOUL.md", content: "custom work soul" });

    const files = makeFiles({ path: path.join(tempDir, DEFAULT_SOUL_FILENAME) });
    const updated = await applySeveranceOverride({
      files,
      workspaceDir: tempDir,
      config: {
        activation: { mode: "manual", persona: "innie" },
        files: { soulInnie: "WORK_SOUL.md" },
      },
    });

    const soul = updated.find((f) => f.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.content).toBe("custom work soul");
  });

  it("leaves files untouched when SOUL.md not in bootstrap", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_SOUL_INNIE, content: "work soul" });
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: path.join(tempDir, "AGENTS.md"),
        content: "agents",
        missing: false,
      },
    ];

    const updated = await applySeveranceOverride({
      files,
      workspaceDir: tempDir,
      config: { activation: { mode: "manual", persona: "innie" } },
    });

    expect(updated).toEqual(files);
  });
});
