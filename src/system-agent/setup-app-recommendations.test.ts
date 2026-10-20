import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as clawHubSkills from "../infra/clawhub-skills.js";
import * as catalog from "../plugins/official-external-plugin-catalog.js";
import type { OfficialExternalPluginCatalogEntry } from "../plugins/official-external-plugin-catalog.js";
import { defaultRuntime } from "../runtime.js";
import {
  getSetupAppRecommendations as getRecommendations,
  type SetupAppScanPhase,
} from "./setup-app-recommendations.js";
import * as inference from "./setup-inference.js";

afterEach(() => vi.restoreAllMocks());

async function getSetupAppRecommendations(
  params: Omit<Parameters<typeof getRecommendations>[0], "runtime"> & {
    deps?: {
      listPlugins?: typeof catalog.listOfficialExternalPluginCatalogEntries;
      listChannels?: typeof catalog.listOfficialExternalChannelCatalogEntries;
      listProviders?: typeof catalog.listOfficialExternalProviderCatalogEntries;
      searchSkills?: typeof clawHubSkills.searchClawHubSkills;
      complete?: (prompt: string) => Promise<{ ok: true; text: string }>;
    };
  },
) {
  const { deps = {}, ...request } = params;
  if (deps.listPlugins) {
    vi.spyOn(catalog, "listOfficialExternalPluginCatalogEntries").mockImplementation(
      deps.listPlugins,
    );
  }
  if (deps.listChannels) {
    vi.spyOn(catalog, "listOfficialExternalChannelCatalogEntries").mockImplementation(
      deps.listChannels,
    );
  }
  if (deps.listProviders) {
    vi.spyOn(catalog, "listOfficialExternalProviderCatalogEntries").mockImplementation(
      deps.listProviders,
    );
  }
  if (deps.searchSkills) {
    vi.spyOn(clawHubSkills, "searchClawHubSkills").mockImplementation(deps.searchSkills);
  }
  if (deps.complete) {
    const complete = deps.complete;
    vi.spyOn(inference, "completeSetupInference").mockImplementation(async ({ prompt }) => ({
      ...(await complete(prompt)),
      modelRef: "mock/model",
      latencyMs: 0,
    }));
  }
  return await getRecommendations({ ...request, runtime: defaultRuntime });
}

const emptyCatalogs = { listPlugins: () => [], listChannels: () => [], listProviders: () => [] };
function skill(
  overrides: Partial<clawHubSkills.ClawHubSkillSearchResult> = {},
): clawHubSkills.ClawHubSkillSearchResult {
  const ownerHandle = overrides.ownerHandle ?? "demo-owner";
  const slug = overrides.slug ?? "notes-tools";
  return {
    registry: "https://clawhub.ai",
    score: 1,
    slug,
    installRef: `@${ownerHandle}/${slug}`,
    ownerHandle,
    displayName: "Notes Tools",
    ...overrides,
  };
}
function match(candidateId = "@demo-owner/notes-tools", reason = "Looks useful") {
  return { appLabel: "Notes", candidateId, tier: "optional", reason };
}

const completeText = (text: string) => async () => ({ ok: true as const, text });

function completeMatching(
  pairs: Array<{ appLabel: string; candidateId: string }>,
): (prompt: string) => Promise<{ ok: true; text: string }> {
  return completeText(
    JSON.stringify({
      matches: pairs.map((pair) => ({ ...pair, tier: "optional", reason: "match" })),
    }),
  );
}

function officialEntry(
  id: string,
  label: string,
  description: string,
  channel = false,
): OfficialExternalPluginCatalogEntry {
  return {
    id,
    description,
    openclaw: {
      plugin: { id, label },
      ...(channel ? { channel: { id, label } } : {}),
    },
  };
}
const appInventory =
  (...labels: string[]) =>
  async () =>
    labels.map((label) => ({ label }));

describe("setup app recommendation candidates", () => {
  it("reports candidate and matching phases for the normalized app inventory", async () => {
    const phases: SetupAppScanPhase[] = [];

    await getSetupAppRecommendations({
      inventorySource: appInventory("Zulu", "alpha", "Echo", "Bravo"),
      onPhase: (phase) => phases.push(phase),
      deps: {
        ...emptyCatalogs,
        searchSkills: async ({ query }) => [
          skill({
            slug: `${query.toLocaleLowerCase("en-US")}-tools`,
            installRef: `@demo-owner/${query.toLocaleLowerCase("en-US")}-tools`,
            displayName: `${query} Tools`,
          }),
        ],
        complete: completeMatching([{ appLabel: "alpha", candidateId: "@demo-owner/alpha-tools" }]),
      },
    });

    expect(phases).toEqual([
      {
        kind: "candidates",
        appCount: 4,
        sampleLabels: ["alpha", "Bravo", "Echo"],
      },
      { kind: "matching", appCount: 4 },
    ]);
  });

  it.each([
    {
      reason: "unsupported",
      inventory: { status: "unsupported" as const, apps: [] as [] },
    },
    { reason: "no-apps", inventory: [] },
  ])("does not report phases when the scan skips for $reason", async ({ inventory }) => {
    const onPhase = vi.fn();

    await getSetupAppRecommendations({
      inventorySource: async () => inventory,
      onPhase,
    });

    expect(onPhase).not.toHaveBeenCalled();
  });

  it("preserves the ClawHub publisher in candidate ids", async () => {
    const result = await getSetupAppRecommendations({
      inventorySource: appInventory("Notes"),
      deps: {
        ...emptyCatalogs,
        searchSkills: async () => [
          skill(),
          skill({ ownerHandle: "other-owner", displayName: "Other Notes Tools" }),
          skill({ ownerHandle: undefined }),
        ],
        complete: completeMatching([{ appLabel: "Notes", candidateId: "@demo-owner/notes-tools" }]),
      },
    });

    assert(result.status === "ok");
    expect(result.groups[0]?.candidates.map((candidate) => candidate.id)).toEqual([
      "@demo-owner/notes-tools",
      "@other-owner/notes-tools",
    ]);
    expect(result.matches[0]?.candidate.id).toBe("@demo-owner/notes-tools");
  });

  it("gathers, dedupes, and sorts official and ClawHub candidates", async () => {
    const channel = officialEntry("chat", "Chat", "Chat desktop channel", true);
    const generic = officialEntry("notes", "Notes", "Notes integration");
    const searchSkills = vi.fn(async () => [
      skill({ score: 2, displayName: "Duplicate notes" }),
      skill({ summary: "Work with notes" }),
    ]);

    const result = await getSetupAppRecommendations({
      inventorySource: appInventory("Notes", "Chat Desktop"),
      deps: {
        listPlugins: () => [generic, channel],
        listChannels: () => [channel],
        listProviders: () => [],
        searchSkills,
        complete: completeMatching([{ appLabel: "Notes", candidateId: "notes" }]),
      },
    });

    assert(result.status === "ok");
    expect(result.groups.map((group) => group.app.label)).toEqual(["Chat Desktop", "Notes"]);
    const notes = result.groups.find((group) => group.app.label === "Notes");
    expect(notes?.candidates.map((candidate) => [candidate.source, candidate.id])).toEqual([
      ["official-plugin", "notes"],
      ["clawhub-skill", "@demo-owner/notes-tools"],
    ]);
    expect(searchSkills).toHaveBeenCalledTimes(2);
  });

  it("degrades one failed ClawHub search without aborting other apps", async () => {
    const searchSkills = vi.fn(async ({ query }: { query: string }) => {
      if (query === "Broken") {
        throw new Error("offline");
      }
      return [skill({ slug: "working" })];
    });
    const result = await getSetupAppRecommendations({
      inventorySource: appInventory("Broken", "Working"),
      deps: {
        ...emptyCatalogs,
        searchSkills,
        complete: completeMatching([{ appLabel: "Working", candidateId: "@demo-owner/working" }]),
      },
    });
    assert(result.status === "ok");
    expect(result.groups.find((group) => group.app.label === "Broken")?.candidates).toEqual([]);
    expect(result.groups.find((group) => group.app.label === "Working")?.candidates).toHaveLength(
      1,
    );
  });
});

describe("official catalog candidates", () => {
  it("produces channel candidates from the real package-shaped catalogs", async () => {
    // Regression: real catalog entries carry no top-level id; keying by it
    // used to collapse the whole catalog and drop every official candidate.
    const result = await getSetupAppRecommendations({
      inventorySource: appInventory("Discord", "WhatsApp"),
      deps: {
        searchSkills: async () => [],
        complete: completeMatching([
          { appLabel: "Discord", candidateId: "discord" },
          { appLabel: "WhatsApp", candidateId: "whatsapp" },
        ]),
      },
    });
    assert(result.status === "ok");
    for (const [label, id] of [
      ["Discord", "discord"],
      ["WhatsApp", "whatsapp"],
    ]) {
      expect(result.groups.find((group) => group.app.label === label)?.candidates).toContainEqual(
        expect.objectContaining({ id, source: "official-channel" }),
      );
    }
  });
});

describe("setup app recommendation matcher", () => {
  const inventorySource = async () => [{ label: "Notes", bundleId: "com.example.notes" }];
  const candidateDeps = {
    ...emptyCatalogs,
    searchSkills: async () => [skill({ summary: "Work with notes" })],
  };

  it("tolerates fenced JSON with extra keys and long reasons", async () => {
    const reason = `${"a".repeat(118)}🤖suffix`;
    const result = await getSetupAppRecommendations({
      inventorySource,
      deps: {
        ...candidateDeps,
        complete: completeText(
          [
            "Here you go:",
            "```json",
            JSON.stringify({ matches: [{ ...match(undefined, reason), confidence: "high" }] }),
            "```",
          ].join("\n"),
        ),
      },
    });
    assert(result.status === "ok");
    expect(result.matches[0]?.candidateId).toBe("@demo-owner/notes-tools");
    expect(result.matches[0]?.reason).toBe(`${"a".repeat(118)}…`);
    expect(result.matches[0]?.reason.length).toBeLessThanOrEqual(120);
  });

  it("uses the first complete object when prose contains later JSON", async () => {
    const result = await getSetupAppRecommendations({
      inventorySource,
      deps: {
        ...candidateDeps,
        complete: completeText(
          `${JSON.stringify({
            matches: [
              { ...match(undefined, "Connects directly to your notes"), tier: "recommended" },
            ],
          })}\nDiagnostics: {"tokens":12}`,
        ),
      },
    });

    assert(result.status === "ok");
    expect(result.matches[0]?.candidateId).toBe("@demo-owner/notes-tools");
  });

  it("skips garbage model output", async () => {
    await expect(
      getSetupAppRecommendations({
        inventorySource,
        deps: { ...candidateDeps, complete: completeText("not json") },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "model-failed" });
  });

  it("drops unknown candidate ids", async () => {
    await expect(
      getSetupAppRecommendations({
        inventorySource,
        deps: {
          ...candidateDeps,
          complete: completeText(JSON.stringify({ matches: [match("unknown")] })),
        },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "no-matches" });
  });
});
