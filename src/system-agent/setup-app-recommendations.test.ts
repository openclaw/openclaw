import { describe, expect, it, vi } from "vitest";
import type { OfficialExternalPluginCatalogEntry } from "../plugins/official-external-plugin-catalog.js";
import { defaultRuntime } from "../runtime.js";
import {
  gatherSetupAppCandidates,
  getSetupAppRecommendations,
  normalizeNodeAppsInventory,
} from "./setup-app-recommendations.js";

function officialEntry(params: {
  id: string;
  label: string;
  description: string;
  kind?: "channel" | "provider";
}): OfficialExternalPluginCatalogEntry {
  return {
    id: params.id,
    description: params.description,
    openclaw: {
      plugin: { id: params.id, label: params.label },
      ...(params.kind === "channel" ? { channel: { id: params.id, label: params.label } } : {}),
      ...(params.kind === "provider" ? { providers: [{ id: params.id, name: params.label }] } : {}),
    },
  };
}

describe("setup app recommendation candidates", () => {
  it("gathers, dedupes, and sorts official and ClawHub candidates", async () => {
    const channel = officialEntry({
      id: "chat",
      label: "Chat",
      description: "Chat desktop channel",
      kind: "channel",
    });
    const generic = officialEntry({
      id: "notes",
      label: "Notes",
      description: "Notes integration",
    });
    const searchSkills = vi.fn(async () => [
      { score: 2, slug: "notes", displayName: "Duplicate notes" },
      { score: 1, slug: "notes-tools", displayName: "Notes Tools", summary: "Work with notes" },
    ]);

    const groups = await gatherSetupAppCandidates({
      apps: [{ label: "Notes" }, { label: "Chat Desktop" }],
      deps: {
        listPlugins: () => [generic, channel],
        listChannels: () => [channel],
        listProviders: () => [],
        searchSkills,
      },
    });

    expect(groups.map((group) => group.app.label)).toEqual(["Chat Desktop", "Notes"]);
    expect(groups[1]?.candidates.map((candidate) => [candidate.source, candidate.id])).toEqual([
      ["official-plugin", "notes"],
      ["clawhub-skill", "notes-tools"],
    ]);
    expect(searchSkills).toHaveBeenCalledTimes(2);
  });

  it("degrades one failed ClawHub search without aborting other apps", async () => {
    const searchSkills = vi.fn(async ({ query }: { query: string }) => {
      if (query === "Broken") {
        throw new Error("offline");
      }
      return [{ score: 1, slug: "working", displayName: "Working" }];
    });
    const groups = await gatherSetupAppCandidates({
      apps: [{ label: "Broken" }, { label: "Working" }],
      deps: {
        listPlugins: () => [],
        listChannels: () => [],
        listProviders: () => [],
        searchSkills,
      },
    });
    expect(groups[0]?.candidates).toEqual([]);
    expect(groups[1]?.candidates).toHaveLength(1);
  });
});

describe("setup app recommendation matcher", () => {
  const inventorySource = async () => [{ label: "Notes", bundleId: "com.example.notes" }];
  const candidateDeps = {
    listPlugins: () => [],
    listChannels: () => [],
    listProviders: () => [],
    searchSkills: async () => [
      { score: 1, slug: "notes-tools", displayName: "Notes Tools", summary: "Work with notes" },
    ],
  };

  it("accepts strict JSON", async () => {
    const result = await getSetupAppRecommendations({
      inventorySource,
      runtime: defaultRuntime,
      deps: {
        ...candidateDeps,
        complete: async () => ({
          ok: true,
          text: JSON.stringify({
            matches: [
              {
                appLabel: "Notes",
                candidateId: "notes-tools",
                tier: "recommended",
                reason: "Connects directly to your notes",
              },
            ],
          }),
        }),
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.matches[0]).toMatchObject({ candidateId: "notes-tools", tier: "recommended" });
    }
  });

  it("tolerates fenced JSON with extra keys and long reasons", async () => {
    const reason = `useful ${"very ".repeat(40)}integration`;
    const result = await getSetupAppRecommendations({
      inventorySource,
      runtime: defaultRuntime,
      deps: {
        ...candidateDeps,
        complete: async () => ({
          ok: true,
          text: [
            "Here you go:",
            "```json",
            JSON.stringify({
              matches: [
                {
                  appLabel: "Notes",
                  candidateId: "notes-tools",
                  tier: "optional",
                  reason,
                  confidence: "high",
                },
              ],
            }),
            "```",
          ].join("\n"),
        }),
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.matches[0]?.candidateId).toBe("notes-tools");
      expect(result.matches[0]?.reason.length).toBeLessThanOrEqual(120);
    }
  });

  it("skips garbage model output", async () => {
    await expect(
      getSetupAppRecommendations({
        inventorySource,
        runtime: defaultRuntime,
        deps: { ...candidateDeps, complete: async () => ({ ok: true, text: "not json" }) },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "model-failed" });
  });

  it("drops unknown candidate ids", async () => {
    await expect(
      getSetupAppRecommendations({
        inventorySource,
        runtime: defaultRuntime,
        deps: {
          ...candidateDeps,
          complete: async () => ({
            ok: true,
            text: JSON.stringify({
              matches: [
                {
                  appLabel: "Notes",
                  candidateId: "unknown",
                  tier: "optional",
                  reason: "Looks useful",
                },
              ],
            }),
          }),
        },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "no-matches" });
  });

  it("normalizes Android and macOS node app identifiers", () => {
    expect(
      normalizeNodeAppsInventory({
        apps: [
          { label: "Mac", bundleId: "com.example.mac" },
          { label: "Android", packageName: "com.example.android" },
        ],
      }),
    ).toEqual([
      { label: "Android", bundleId: "com.example.android" },
      { label: "Mac", bundleId: "com.example.mac" },
    ]);
  });
});
