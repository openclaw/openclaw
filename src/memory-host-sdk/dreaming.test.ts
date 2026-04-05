import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg: OpenClawConfig, agentId: string) => `/workspace/${agentId}`),
);
const resolveMemorySearchConfig = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, _agentId: string) => { enabled: boolean } | null>(() => ({
    enabled: true,
  })),
);

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

import {
  formatMemoryDreamingDay,
  isSameMemoryDreamingDay,
  resolveMemoryCorePluginConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
} from "./dreaming.js";

describe("memory dreaming host helpers", () => {
  it("normalizes string settings from the dreaming config", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          timezone: "Europe/London",
          storage: {
            mode: "both",
            separateReports: true,
          },
          phases: {
            deep: {
              cron: "0 */4 * * *",
              limit: "5",
              minScore: "0.9",
              minRecallCount: "4",
              minUniqueQueries: "2",
              recencyHalfLifeDays: "21",
              maxAgeDays: "30",
            },
          },
        },
      },
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.timezone).toBe("Europe/London");
    expect(resolved.storage).toEqual({
      mode: "both",
      separateReports: true,
    });
    expect(resolved.phases.deep).toMatchObject({
      cron: "0 */4 * * *",
      limit: 5,
      minScore: 0.9,
      minRecallCount: 4,
      minUniqueQueries: 2,
      recencyHalfLifeDays: 21,
      maxAgeDays: 30,
    });
  });

  it("falls back to cfg timezone and deep defaults", () => {
    const cfg = {
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
        },
      },
    } as OpenClawConfig;

    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {},
      cfg,
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.timezone).toBe("America/Los_Angeles");
    expect(resolved.phases.deep).toMatchObject({
      cron: "0 3 * * *",
      limit: 10,
      minScore: 0.8,
      recencyHalfLifeDays: 14,
      maxAgeDays: 30,
    });
  });

  it("dedupes shared workspaces and skips agents without memory search", () => {
    resolveMemorySearchConfig.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "beta" ? null : { enabled: true },
    );
    resolveAgentWorkspaceDir.mockImplementation((_cfg: OpenClawConfig, agentId: string) => {
      if (agentId === "alpha") {
        return "/workspace/shared";
      }
      if (agentId === "gamma") {
        return "/workspace/shared";
      }
      return `/workspace/${agentId}`;
    });

    const cfg = {
      agents: {
        list: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
      },
    } as OpenClawConfig;

    expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual([
      {
        workspaceDir: "/workspace/shared",
        agentIds: ["alpha", "gamma"],
      },
    ]);
  });

  it("uses default agent fallback and timezone-aware day helpers", () => {
    resolveDefaultAgentId.mockReturnValue("fallback");
    const cfg = {} as OpenClawConfig;

    expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual([
      {
        workspaceDir: "/workspace/fallback",
        agentIds: ["fallback"],
      },
    ]);

    expect(
      formatMemoryDreamingDay(Date.parse("2026-04-02T06:30:00.000Z"), "America/Los_Angeles"),
    ).toBe("2026-04-01");
    expect(
      isSameMemoryDreamingDay(
        Date.parse("2026-04-02T06:30:00.000Z"),
        Date.parse("2026-04-02T06:50:00.000Z"),
        "America/Los_Angeles",
      ),
    ).toBe(true);
    expect(
      resolveMemoryCorePluginConfig({
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      dreaming: {
        enabled: true,
      },
    });
  });
});
