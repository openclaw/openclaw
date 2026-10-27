import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
// Field, accepted decimal value, malformed input, fallback.
const deepFields = [
  ["limit", 5, "0x10", 10],
  ["minScore", 0.9, undefined, 0.75],
  ["minRecallCount", 4, "1e3", 3],
  ["minUniqueQueries", 2, "2.5", 3],
  ["recencyHalfLifeDays", 21, "1.5", 14],
  ["maxAgeDays", 30, "0x20", 30],
  ["maxPromotedSnippetTokens", 160, "1e2", 160],
  ["maxPriorEntryLossFraction", 0.1, undefined, 0.25],
] as const;
const deepSettings = (column: 1 | 2 | 3) =>
  Object.fromEntries(deepFields.map((row) => [row[0], row[column]]));
const workspace = (workspaceDir: string, ...agentIds: string[]) => ({ workspaceDir, agentIds });
const memoryPlugin = (slot: string, id: string, dreaming: Record<string, unknown>) => ({
  plugins: { slots: { memory: slot }, entries: { [id]: { config: { dreaming } } } },
});

it("normalizes string settings from the dreaming config", () => {
  const deep = deepSettings(1);
  const resolved = resolveConfig({
    enabled: true,
    frequency: "0 */4 * * *",
    timezone: "Europe/London",
    verboseLogging: "false",
    storage: { mode: "inline", separateReports: true },
    phases: {
      light: { enabled: " FALSE " },
      deep: Object.fromEntries(Object.entries(deep).map(([key, value]) => [key, String(value)])),
    },
  });

  expect(resolved.enabled).toBe(true);
  expect(resolved.frequency).toBe("0 */4 * * *");
  expect(resolved.timezone).toBe("Europe/London");
  expect(resolved.verboseLogging).toBe(false);
  expect(resolved.phases.light.enabled).toBe(false);
  for (const phase of Object.values(resolved.phases)) {
    expect(phase.cron).toBe("0 */4 * * *");
  }
  expect(resolved.storage).toEqual({ mode: "inline", separateReports: true });
  expect(resolved.phases.deep).toMatchObject(deep);
});

it.each([
  ["missing", {}],
  [
    "malformed",
    {
      enabled: " TRUE ",
      storage: { separateReports: "invalid" },
      phases: {
        deep: {
          ...deepSettings(2),
          execution: { maxOutputTokens: "0x40", timeoutMs: "1e4" },
        },
        light: { lookbackDays: "0x0a", limit: "1e2" },
      },
    },
  ],
] as const)("uses local defaults for %s settings", (_name, input) => {
  const cfg = { agents: { defaults: { userTimezone: "America/Los_Angeles" } } };
  const resolved = resolveConfig(input, cfg);
  expect(resolved).toMatchObject({
    enabled: true,
    frequency: "0 3 * * *",
    timezone: "America/Los_Angeles",
    phases: {
      light: { lookbackDays: 2, limit: 100 },
      deep: {
        cron: "0 3 * * *",
        ...deepSettings(3),
      },
    },
  });
  expect(resolved.phases.deep.execution.maxOutputTokens).toBeUndefined();
  expect(resolved.phases.deep.execution.timeoutMs).toBeUndefined();
  expect(resolved.storage).toEqual({ mode: "separate", separateReports: false });
});

it.each([
  [{ model: " top " }, ["top", "top", "top", "top"]],
  [
    {
      model: "top",
      execution: { defaults: { model: "default" } },
      phases: { rem: { execution: { model: "phase" } } },
    },
    ["default", "default", "default", "phase"],
  ],
] as const)("resolves model inheritance for %j", (input, expected) => {
  const resolved = resolveConfig(input);
  const executions = [
    resolved.execution.defaults,
    ...Object.values(resolved.phases).map((p) => p.execution),
  ];
  expect(executions.map(({ model }) => model)).toEqual(expected);
});

it.each([
  ["returns no workspaces for an explicitly empty roster", { agents: { entries: {} } }, []],
  [
    "uses default agent fallback",
    { agents: { entries: { main: {} }, defaults: { workspace: "/workspace" } } },
    [workspace("/workspace", "main")],
  ],
] as const)("%s", (_name, cfg, expected) => {
  expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual(expected);
});

it("canonicalizes agents and dedupes non-adjacent symlinks without a default owner", async () => {
  const root = tempDirs.make("openclaw-dreaming-workspace-");
  const dir = path.join(root, "workspace");
  const alias = path.join(root, "alias");
  const other = path.join(root, "other");
  await fs.mkdir(dir);
  await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: {
        "Team Alpha": { workspace: dir },
        "team-alpha": { workspace: dir },
        gamma: { workspace: other },
        beta: { workspace: alias },
      },
    },
  };
  expect(
    resolveMemoryDreamingWorkspaces(cfg, {
      primaryWorkspaceDir: "/main",
      primaryAgentId: "main",
    }),
  ).toEqual([
    workspace(dir, "team-alpha", "beta"),
    workspace(other, "gamma"),
    workspace("/main", "main"),
  ]);
  expect(resolveMemoryDreamingWorkspace(cfg, alias)).toEqual(workspace(dir, "team-alpha", "beta"));
});

it("preserves timezone-aware day selection and local fallback", () => {
  const epochMs = Date.parse("2026-04-02T06:30:00.000Z");
  const localDate = new Date(epochMs);
  const localDay = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")}`;
  for (const [timestamp, timezone, expected] of [
    [epochMs, "America/Los_Angeles", "2026-04-01"],
    [epochMs, "UTC", "2026-04-02"],
    [epochMs, "America/Los_Angeles", "2026-04-01"],
    [epochMs, "Invalid/Timezone", localDay],
    [epochMs, undefined, localDay],
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

it.each([
  ["memory-lancedb", "memory-lancedb"],
  ["none", "memory-core"],
  ["   ", "memory-core"],
])("reads the owning memory plugin for slot %j", (slot, id) => {
  const dreaming = { enabled: true, frequency: "0 */6 * * *" };
  const cfg = memoryPlugin(slot, id, dreaming);
  expect(resolveMemoryDreamingPluginId(cfg)).toBe(id);
  expect(resolveMemoryDreamingPluginConfig(cfg)).toEqual({ dreaming });
});
