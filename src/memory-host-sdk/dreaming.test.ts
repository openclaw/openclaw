import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg: OpenClawConfig, agentId: string) => `/workspace/${agentId}`),
);
const resolveMemorySearchConfig = vi.hoisted(() =>
  vi.fn((_cfg: OpenClawConfig, _agentId: string) => ({ enabled: true })),
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
  it("prefers cron over legacy frequency and normalizes string settings", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          mode: "deep",
          cron: "0 */4 * * *",
          frequency: "0 */12 * * *",
          timezone: "Europe/London",
          limit: "5",
          minScore: "0.9",
          minRecallCount: "4",
          minUniqueQueries: "2",
          verboseLogging: "true",
        },
      },
    });

    expect(resolved).toEqual({
      mode: "deep",
      enabled: true,
      cron: "0 */4 * * *",
      timezone: "Europe/London",
      limit: 5,
      minScore: 0.9,
      minRecallCount: 4,
      minUniqueQueries: 2,
      verboseLogging: true,
    });
  });

  it("falls back to cfg timezone and core defaults when mode is off", () => {
    const cfg = {
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
        },
      },
    } as OpenClawConfig;

    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          mode: "off",
        },
      },
      cfg,
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.cron).toBe("0 3 * * *");
    expect(resolved.timezone).toBe("America/Los_Angeles");
    expect(resolved.limit).toBe(10);
    expect(resolved.minScore).toBe(0.75);
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
                  mode: "core",
                },
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      dreaming: {
        mode: "core",
      },
    });
  });
});
