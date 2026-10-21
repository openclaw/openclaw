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
function match(
  candidateId = "@demo-owner/notes-tools",
  reason = "Looks useful",
  appLabel = "Notes",
) {
  return { appLabel, candidateId, tier: "optional", reason };
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
async function scan(
  options: {
    labels?: string[];
    inventorySource?: Parameters<typeof getRecommendations>[0]["inventorySource"];
    onPhase?: (phase: SetupAppScanPhase) => void;
    realCatalog?: boolean;
    plugins?: OfficialExternalPluginCatalogEntry[];
    channels?: OfficialExternalPluginCatalogEntry[];
    searchSkills?: typeof clawHubSkills.searchClawHubSkills;
    matches?: ReturnType<typeof match>[];
    text?: string;
  } = {},
) {
  if (!options.realCatalog) {
    vi.spyOn(catalog, "listOfficialExternalPluginCatalogEntries").mockReturnValue(
      options.plugins ?? [],
    );
    vi.spyOn(catalog, "listOfficialExternalChannelCatalogEntries").mockReturnValue(
      options.channels ?? [],
    );
    vi.spyOn(catalog, "listOfficialExternalProviderCatalogEntries").mockReturnValue([]);
  }
  vi.spyOn(clawHubSkills, "searchClawHubSkills").mockImplementation(
    options.searchSkills ?? (async () => [skill({ summary: "Work with notes" })]),
  );
  vi.spyOn(inference, "completeSetupInference").mockResolvedValue({
    ok: true,
    text: options.text ?? JSON.stringify({ matches: options.matches ?? [match()] }),
    modelRef: "mock/model",
    latencyMs: 0,
  });
  return getRecommendations({
    inventorySource:
      options.inventorySource ??
      (async () =>
        options.labels?.map((label) => ({ label })) ?? [
          { label: "Notes", bundleId: "com.example.notes" },
        ]),
    onPhase: options.onPhase,
    runtime: defaultRuntime,
  });
}

describe("setup app recommendation candidates", () => {
  it("reports candidate and matching phases for the normalized app inventory", async () => {
    const phases: SetupAppScanPhase[] = [];

    await scan({
      labels: ["Zulu", "alpha", "Echo", "Bravo"],
      onPhase: (phase) => phases.push(phase),
      searchSkills: async ({ query }) => [
        skill({
          slug: `${query.toLocaleLowerCase("en-US")}-tools`,
          installRef: `@demo-owner/${query.toLocaleLowerCase("en-US")}-tools`,
          displayName: `${query} Tools`,
        }),
      ],
      matches: [match("@demo-owner/alpha-tools", "match", "alpha")],
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

    await getRecommendations({
      inventorySource: async () => inventory,
      onPhase,
      runtime: defaultRuntime,
    });

    expect(onPhase).not.toHaveBeenCalled();
  });

  it("preserves the ClawHub publisher in candidate ids", async () => {
    const result = await scan({
      labels: ["Notes"],
      searchSkills: async () => [
        skill(),
        skill({ ownerHandle: "other-owner", displayName: "Other Notes Tools" }),
        skill({ ownerHandle: undefined }),
      ],
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

    const result = await scan({
      labels: ["Notes", "Chat Desktop"],
      plugins: [generic, channel],
      channels: [channel],
      searchSkills,
      matches: [match("notes")],
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
    const result = await scan({
      labels: ["Broken", "Working"],
      searchSkills,
      matches: [match("@demo-owner/working", "match", "Working")],
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
    const result = await scan({
      labels: ["Discord", "WhatsApp"],
      realCatalog: true,
      searchSkills: async () => [],
      matches: [match("discord", "match", "Discord"), match("whatsapp", "match", "WhatsApp")],
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
  it("tolerates fenced JSON with extra keys and long reasons", async () => {
    const reason = `${"a".repeat(118)}🤖suffix`;
    const result = await scan({
      text: [
        "Here you go:",
        "```json",
        JSON.stringify({ matches: [{ ...match(undefined, reason), confidence: "high" }] }),
        "```",
      ].join("\n"),
    });
    assert(result.status === "ok");
    expect(result.matches[0]?.candidateId).toBe("@demo-owner/notes-tools");
    expect(result.matches[0]?.reason).toBe(`${"a".repeat(118)}…`);
    expect(result.matches[0]?.reason.length).toBeLessThanOrEqual(120);
  });

  it("uses the first complete object when prose contains later JSON", async () => {
    const result = await scan({
      text: `${JSON.stringify({
        matches: [{ ...match(undefined, "Connects directly to your notes"), tier: "recommended" }],
      })}\nDiagnostics: {"tokens":12}`,
    });

    assert(result.status === "ok");
    expect(result.matches[0]?.candidateId).toBe("@demo-owner/notes-tools");
  });

  it.each([
    ["garbage model output", "not json", "model-failed"],
    ["unknown candidate ids", JSON.stringify({ matches: [match("unknown")] }), "no-matches"],
  ])("skips %s", async (_name, text, reason) => {
    await expect(scan({ text })).resolves.toEqual({ status: "skipped", reason });
  });
});
