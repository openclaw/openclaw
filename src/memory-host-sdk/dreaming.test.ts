import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  formatMemoryDreamingDay,
  isSameMemoryDreamingDay,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspace,
  resolveMemoryDreamingWorkspaces,
} from "./dreaming.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const resolveConfig = (dreaming: Record<string, unknown>, cfg?: OpenClawConfig) =>
  resolveMemoryDreamingConfig({ pluginConfig: { dreaming }, cfg });
const roster = (
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  options: Omit<NonNullable<OpenClawConfig["agents"]>, "entries"> = {},
): OpenClawConfig => ({ agents: { ...options, entries } });
const memoryPlugin = (slot: string, id: string, dreaming: Record<string, unknown>) => ({
  plugins: { slots: { memory: slot }, entries: { [id]: { config: { dreaming } } } },
});

describe("memory dreaming host helpers", () => {
  it("normalizes string settings from the dreaming config", () => {
    const deep = {
      limit: 5,
      minScore: 0.9,
      minRecallCount: 4,
      minUniqueQueries: 2,
      recencyHalfLifeDays: 21,
      maxAgeDays: 30,
    };
    const resolved = resolveConfig({
      enabled: true,
      frequency: "0 */4 * * *",
      timezone: "Europe/London",
      model: " anthropic/claude-sonnet-4-6 ",
      storage: { mode: "inline", separateReports: true },
      phases: {
        deep: {
          ...Object.fromEntries(Object.entries(deep).map(([key, value]) => [key, String(value)])),
          maxPriorEntryLossFraction: 0.1,
        },
      },
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.frequency).toBe("0 */4 * * *");
    expect(resolved.timezone).toBe("Europe/London");
    expect(resolved.execution.defaults.model).toBe("anthropic/claude-sonnet-4-6");
    for (const phase of Object.values(resolved.phases)) {
      expect(phase.execution.model).toBe("anthropic/claude-sonnet-4-6");
      expect(phase.cron).toBe("0 */4 * * *");
    }
    expect(resolved.storage).toEqual({ mode: "inline", separateReports: true });
    expect(resolved.phases.deep).toMatchObject({ ...deep, maxPriorEntryLossFraction: 0.1 });
  });

  it("rejects hex and exponent integer strings for dreaming phase counts", () => {
    const fields = [
      ["limit", "0x10", 10],
      ["minRecallCount", "1e3", 3],
      ["minUniqueQueries", "2.5", 3],
      ["recencyHalfLifeDays", "1.5", 14],
      ["maxAgeDays", "0x20", 30],
      ["maxPromotedSnippetTokens", "1e2", 160],
    ] as const;
    const resolved = resolveConfig({
      phases: {
        deep: {
          ...Object.fromEntries(fields.map(([key, value]) => [key, value])),
          execution: { maxOutputTokens: "0x40", timeoutMs: "1e4" },
        },
        light: { lookbackDays: "0x0a", limit: "1e2" },
      },
    });

    for (const [key, , expected] of fields) {
      expect(resolved.phases.deep[key]).toBe(expected);
    }
    expect(resolved.phases.deep.execution.maxOutputTokens).toBeUndefined();
    expect(resolved.phases.deep.execution.timeoutMs).toBeUndefined();
    expect(resolved.phases.light).toMatchObject({ lookbackDays: 2, limit: 100 });
  });

  it("parses true/false strings while keeping invalid-value defaults local", () => {
    const resolved = resolveConfig({
      enabled: " TRUE ",
      verboseLogging: "false",
      storage: { separateReports: "invalid" },
      phases: { light: { enabled: " FALSE " } },
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.verboseLogging).toBe(false);
    expect(resolved.storage.separateReports).toBe(false);
    expect(resolved.phases.light.enabled).toBe(false);
  });

  it("lets execution defaults and phase execution override the top-level dreaming model", () => {
    const resolved = resolveConfig({
      model: "anthropic/claude-haiku-4-5",
      execution: { defaults: { model: "openai/gpt-5.4" } },
      phases: { rem: { execution: { model: "xai/grok-4.1-fast" } } },
    });

    expect(resolved.execution.defaults.model).toBe("openai/gpt-5.4");
    expect(resolved.phases.light.execution.model).toBe("openai/gpt-5.4");
    expect(resolved.phases.deep.execution.model).toBe("openai/gpt-5.4");
    expect(resolved.phases.rem.execution.model).toBe("xai/grok-4.1-fast");
  });

  it("defaults to enabled dreaming with separate storage and the cfg timezone", () => {
    const cfg = { agents: { defaults: { userTimezone: "America/Los_Angeles" } } };
    const resolved = resolveMemoryDreamingConfig({ pluginConfig: {}, cfg });
    expect(resolved.enabled).toBe(true);
    expect(resolved.frequency).toBe("0 3 * * *");
    expect(resolved.timezone).toBe("America/Los_Angeles");
    expect(resolved.phases.deep).toMatchObject({
      cron: "0 3 * * *",
      limit: 10,
      minScore: 0.75,
      recencyHalfLifeDays: 14,
      maxAgeDays: 30,
    });
    expect(resolved.storage).toEqual({ mode: "separate", separateReports: false });
  });

  it("uses canonical roster identities when agent aliases share a workspace", () => {
    const cfg = roster({
      "Team Alpha": { workspace: "/workspace/shared" },
      "team-alpha": { workspace: "/workspace/shared" },
    });
    expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual([
      { workspaceDir: "/workspace/shared", agentIds: ["team-alpha"] },
    ]);
  });

  it("does not require a default owner when no primary workspace is supplied", () => {
    const cfg = roster(
      {
        alpha: { workspace: "/workspace/alpha" },
        beta: { workspace: "/workspace/beta" },
      },
      { ownership: "explicit" },
    );

    expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual([
      { workspaceDir: "/workspace/alpha", agentIds: ["alpha"] },
      { workspaceDir: "/workspace/beta", agentIds: ["beta"] },
    ]);
  });

  it("returns no workspaces for an explicitly empty roster", () => {
    expect(resolveMemoryDreamingWorkspaces({ agents: { entries: {} } })).toEqual([]);
  });

  it("dedupes non-adjacent workspace symlink aliases across agents", async () => {
    const rootDir = tempDirs.make("openclaw-dreaming-workspace-");
    const workspaceDir = path.join(rootDir, "workspace");
    const workspaceAliasDir = path.join(rootDir, "workspace-alias");
    const otherWorkspaceDir = path.join(rootDir, "other-workspace");
    await fs.mkdir(workspaceDir);
    await fs.symlink(
      workspaceDir,
      workspaceAliasDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const cfg = roster({
      alpha: { workspace: workspaceDir },
      gamma: { workspace: otherWorkspaceDir },
      beta: { workspace: workspaceAliasDir },
    });

    expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual([
      { workspaceDir, agentIds: ["alpha", "beta"] },
      { workspaceDir: otherWorkspaceDir, agentIds: ["gamma"] },
    ]);
    expect(resolveMemoryDreamingWorkspace(cfg, workspaceAliasDir)).toEqual({
      workspaceDir,
      agentIds: ["alpha", "beta"],
    });
  });

  it("includes the runtime primary workspace alongside configured subagent workspaces", () => {
    const cfg = roster({
      "agi-ceo": { workspace: "/workspace/agi-ceo" },
      "agi-cdo": { workspace: "/workspace/agi-cdo" },
    });

    expect(
      resolveMemoryDreamingWorkspaces(cfg, {
        primaryWorkspaceDir: "/workspace/main",
        primaryAgentId: "main",
      }),
    ).toEqual([
      { workspaceDir: "/workspace/agi-ceo", agentIds: ["agi-ceo"] },
      { workspaceDir: "/workspace/agi-cdo", agentIds: ["agi-cdo"] },
      { workspaceDir: "/workspace/main", agentIds: ["main"] },
    ]);
  });

  it("uses default agent fallback", () => {
    const cfg = roster({ main: {} }, { defaults: { workspace: "/workspace" } });

    expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual([
      { workspaceDir: "/workspace", agentIds: ["main"] },
    ]);
  });

  it("preserves timezone-aware day selection and local fallback", () => {
    const epochMs = Date.parse("2026-04-02T06:30:00.000Z");
    const localDate = new Date(epochMs);
    const localDay = [
      localDate.getFullYear(),
      String(localDate.getMonth() + 1).padStart(2, "0"),
      String(localDate.getDate()).padStart(2, "0"),
    ].join("-");
    for (const [timestamp, timezone, expected] of [
      [epochMs, "America/Los_Angeles", "2026-04-01"],
      [epochMs, "UTC", "2026-04-02"],
      [epochMs, "America/Los_Angeles", "2026-04-01"],
      [epochMs, "Invalid/Timezone", localDay],
      [epochMs, undefined, localDay],
      [epochMs, "", localDay],
      [Number.NaN, "America/Los_Angeles", "NaN-NaN-NaN"],
      [epochMs, "America/Los_Angeles", "2026-04-01"],
      [Date.parse("2026-04-02T07:00:00.000Z"), "America/Los_Angeles", "2026-04-02"],
    ] as const) {
      expect(formatMemoryDreamingDay(timestamp, timezone)).toBe(expected);
    }
    const sameDay = (first: string, second: string) =>
      isSameMemoryDreamingDay(Date.parse(first), Date.parse(second), "America/Los_Angeles");
    expect(sameDay("2026-04-02T06:30:00.000Z", "2026-04-02T06:50:00.000Z")).toBe(true);
    expect(sameDay("2026-04-02T06:59:59.000Z", "2026-04-02T07:00:00.000Z")).toBe(false);
  });

  it("reads dreaming config from memory-lancedb when it owns the memory slot", () => {
    const dreaming = { enabled: true, frequency: "0 */6 * * *" };
    const cfg = memoryPlugin("memory-lancedb", "memory-lancedb", dreaming);
    expect(resolveMemoryDreamingPluginConfig(cfg)).toEqual({ dreaming });
  });

  it('falls back to memory-core when memory slot is "none" or blank', () => {
    expect(resolveMemoryDreamingPluginId({ plugins: { slots: { memory: "none" } } })).toBe(
      "memory-core",
    );

    const cfg = memoryPlugin("   ", "memory-core", { enabled: true });
    expect(resolveMemoryDreamingPluginConfig(cfg)).toEqual({ dreaming: { enabled: true } });
  });
});
