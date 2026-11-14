import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
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
async function matched(options: Parameters<typeof scan>[0]) {
  const result = await scan(options);
  assert(result.status === "ok");
  return result;
}

function officialEntry(id: string, channel = false): OfficialExternalPluginCatalogEntry {
  return {
    id,
    openclaw: {
      plugin: { id, label: id },
      ...(channel ? { channel: { id, label: id } } : {}),
    },
  };
}
async function scan(
  options: {
    labels?: string[];
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
    inventorySource: async () => (options.labels ?? ["Notes"]).map((label) => ({ label })),
    onPhase: options.onPhase,
    runtime: defaultRuntime,
  });
}

it("reports candidate and matching phases for the normalized app inventory", async () => {
  const phases: SetupAppScanPhase[] = [];

  await scan({
    labels: ["Zulu", "alpha", "Echo", "Bravo"],
    onPhase: (phase) => phases.push(phase),
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

it("gathers, dedupes, and sorts candidates with their ClawHub publisher ids", async () => {
  const channel = officialEntry("chat", true);
  const generic = officialEntry("notes");
  const searchSkills: typeof clawHubSkills.searchClawHubSkills = async ({ query }) => [
    skill(),
    skill({ ownerHandle: query === "Notes" ? "other-owner" : "demo-owner" }),
    skill({ ownerHandle: undefined }),
  ];

  const result = await matched({
    labels: ["Notes", "Chat Desktop"],
    plugins: [generic, channel],
    channels: [channel],
    searchSkills,
    matches: [match()],
  });
  expect(result.groups.map((group) => group.app.label)).toEqual(["Chat Desktop", "Notes"]);
  expect(
    result.groups[0]?.candidates.filter((candidate) => candidate.source === "clawhub-skill"),
  ).toHaveLength(1);
  const notes = result.groups.find((group) => group.app.label === "Notes");
  expect(notes?.candidates.map((candidate) => [candidate.source, candidate.id])).toEqual([
    ["official-plugin", "notes"],
    ["clawhub-skill", "@demo-owner/notes-tools"],
    ["clawhub-skill", "@other-owner/notes-tools"],
  ]);
  expect(result.matches[0]?.candidate.id).toBe("@demo-owner/notes-tools");
});

it("degrades one failed ClawHub search without aborting other apps", async () => {
  const searchSkills = vi.fn(async ({ query }: { query: string }) => {
    if (query === "Broken") {
      throw new Error("offline");
    }
    return [skill({ slug: "working" })];
  });
  const result = await matched({
    labels: ["Broken", "Working"],
    searchSkills,
    matches: [match("@demo-owner/working", "match", "Working")],
  });
  expect(result.groups.find((group) => group.app.label === "Broken")?.candidates).toEqual([]);
  expect(result.groups.find((group) => group.app.label === "Working")?.candidates).toHaveLength(1);
});
it("produces channel candidates from the real package-shaped catalogs", async () => {
  // Regression: real catalog entries carry no top-level id; keying by it
  // used to collapse the whole catalog and drop every official candidate.
  const result = await matched({
    labels: ["Discord", "WhatsApp"],
    realCatalog: true,
    searchSkills: async () => [],
    matches: [match("discord", "match", "Discord"), match("whatsapp", "match", "WhatsApp")],
  });
  for (const [label, id] of [
    ["Discord", "discord"],
    ["WhatsApp", "whatsapp"],
  ]) {
    expect(result.groups.find((group) => group.app.label === label)?.candidates).toContainEqual(
      expect.objectContaining({ id, source: "official-channel" }),
    );
  }
});
it("tolerates fenced JSON with extra keys and long reasons", async () => {
  const reason = `${"a".repeat(118)}🤖suffix`;
  const result = await matched({
    text: [
      "Here you go:",
      "```json",
      JSON.stringify({ matches: [{ ...match(undefined, reason), confidence: "high" }] }),
      "```",
    ].join("\n"),
  });
  expect(result.matches[0]?.candidateId).toBe("@demo-owner/notes-tools");
  expect(result.matches[0]?.reason).toBe(`${"a".repeat(118)}…`);
  expect(result.matches[0]?.reason.length).toBeLessThanOrEqual(120);
});

it.each([
  ["garbage model output", "not json", "model-failed"],
  ["unknown candidate ids", JSON.stringify({ matches: [match("unknown")] }), "no-matches"],
])("skips %s", async (_name, text, reason) => {
  await expect(scan({ text })).resolves.toEqual({ status: "skipped", reason });
});
