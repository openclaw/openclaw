/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { DoctorMemoryStatusPayload } from "../../../../src/gateway/server-methods/doctor.ts";

// The hero derives its lobster from lobsterPetSeed, which mixes in a random
// per-load salt, so the palette (and with it sprite geometry like the sleeping
// eye peek) varies per test process. Pin a canonical look so pose assertions
// stay deterministic.
vi.mock("../../components/lobster-pet-look.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/lobster-pet-look.ts")>();
  const { LOBSTER_PET_PALETTES } = await import("../../components/lobster-pet-palettes.ts");
  return {
    ...actual,
    createLobsterPetLook: () =>
      actual.canonicalLobsterLook(
        expectDefined(LOBSTER_PET_PALETTES[0], "canonical lobster palette"),
      ),
  };
});

import { renderMemoryOverview, type MemoryOverviewStatus } from "./memory-overview.ts";

type MemoryOverviewProps = Parameters<typeof renderMemoryOverview>[0];

function fixturePayload(): DoctorMemoryStatusPayload {
  const phaseBase = {
    enabled: true,
    cron: "0 3 * * *",
    managedCronPresent: true,
    nextRunAtMs: Date.now() + 60_000,
  };
  return {
    agentId: "main",
    provider: "local",
    embedding: { ok: true, checked: true },
    embeddingRuntime: {
      engine: "llama.cpp",
      state: "ready",
      backend: "metal",
      buildInfo: "b10357 (689e227db)",
      model: { id: "embeddinggemma-300m-qat-q8_0" },
      endpoints: {
        health: "ready",
        models: "ready",
        props: "ready",
        metrics: "ready",
      },
    },
    dreaming: {
      enabled: true,
      timezone: "Europe/Vienna",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 4,
      recallSignalCount: 8,
      dailySignalCount: 3,
      groundedSignalCount: 2,
      totalSignalCount: 13,
      phaseSignalCount: 7,
      lightPhaseHitCount: 5,
      remPhaseHitCount: 2,
      promotedTotal: 21,
      promotedToday: 3,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { ...phaseBase, lookbackDays: 7, limit: 20 },
        deep: {
          ...phaseBase,
          limit: 10,
          minScore: 0.7,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 14,
        },
        rem: { ...phaseBase, lookbackDays: 30, limit: 10, minPatternStrength: 0.6 },
      },
    },
  };
}

function renderOverview(
  status: MemoryOverviewStatus,
  engineSelection: MemoryOverviewProps["engineSelection"] = {
    kind: "auto",
    engineId: "memory-core",
  },
  overrides: Partial<MemoryOverviewProps> = {},
) {
  const container = document.createElement("div");
  render(
    renderMemoryOverview({
      agentId: "main",
      engineSelection,
      engineDisabled: false,
      status,
      probingEmbeddings: false,
      onRefresh: vi.fn(),
      onProbeEmbeddings: vi.fn(),
      onNavigate: vi.fn(),
      ...overrides,
    }),
    container,
  );
  return container;
}

describe("renderMemoryOverview", () => {
  it("renders the awake reading hero and status cards from one payload", () => {
    const container = renderOverview({ kind: "ready", payload: fixturePayload() });

    expect(container.textContent).toContain("Memory is awake");
    expect(container.textContent).toContain("memory-core · hybrid search");
    expect(container.querySelector(".lob-reading-book")).not.toBeNull();
    expect(container.textContent).toContain("Sleep schedule");
    expect(container.textContent).toContain("Europe/Vienna");
    expect(container.textContent).toContain("Promoted today");
    expect(container.textContent).toContain("21");
    expect(container.textContent).toContain("b10357 (689e227db)");
    expect(container.textContent).toContain("metrics=ready");
  });

  it("renders a grumpy error hero with retry and no book", () => {
    const container = renderOverview({ kind: "error", message: "gateway request failed" });

    expect(container.textContent).toContain("Memory needs attention");
    expect(container.textContent).toContain("gateway request failed");
    expect(container.textContent).toContain("Retry");
    expect(container.querySelector(".lob-reading-book")).toBeNull();
  });

  it("renders the dimmed sleeping hero when the engine is off", () => {
    const container = renderOverview({ kind: "idle" }, { kind: "off" });

    expect(container.textContent).toContain("Memory is hibernating");
    expect(container.textContent).toContain("Open Settings");
    expect(container.querySelector(".memory-overview__hero--sleeping")).not.toBeNull();
    expect(container.querySelector(".lobster-pet__svg")).not.toBeNull();
    expect(container.querySelector(".lob-reading-book")).toBeNull();
  });

  it("hibernates a disabled pinned engine and points to Settings", () => {
    const container = renderOverview(
      { kind: "ready", payload: fixturePayload() },
      { kind: "pinned", engineId: "memory-core" },
      { engineDisabled: true },
    );

    expect(container.textContent).toContain("Memory is hibernating");
    expect(container.textContent).toContain("selected memory engine is disabled");
    expect(container.textContent).toContain("Open Settings");
    expect(container.querySelector(".lob-reading-book")).toBeNull();
    expect(container.textContent).not.toContain("Engine health");
    expect(container.textContent).not.toContain("Sleep schedule");
  });

  it("reports every phase disabled when the global dream cycle is off", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.enabled = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const phaseRows = [...container.querySelectorAll(".settings-row")].filter((row) =>
      /Light phase|Deep phase|REM phase/.test(row.textContent ?? ""),
    );

    expect(phaseRows).toHaveLength(3);
    expect(phaseRows.every((row) => row.textContent?.includes("Disabled"))).toBe(true);
    expect(phaseRows.every((row) => !row.textContent?.includes("next "))).toBe(true);
  });

  it("schedules the phases a slot owner reports running while the host toggle is off", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.enabled = false;
      payload.dreaming.reportedEnabled = true;
    }
    const container = renderOverview({ kind: "ready", payload });
    const phaseRows = [...container.querySelectorAll(".settings-row")].filter((row) =>
      /Light phase|Deep phase|REM phase/.test(row.textContent ?? ""),
    );

    expect(phaseRows).toHaveLength(3);
    expect(phaseRows.every((row) => row.textContent?.includes("Enabled"))).toBe(true);
    expect(phaseRows.some((row) => row.textContent?.includes("Disabled"))).toBe(false);
  });

  it("keeps a still scheduled host phase enabled beside an owner that reports off", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.reportedByProvider = true;
      payload.dreaming.reportedEnabled = false;
      payload.dreaming.phases.rem.enabled = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const row = (name: string) =>
      [...container.querySelectorAll(".settings-row")].find((entry) =>
        entry.textContent?.includes(name),
      );

    expect(row("Light phase")?.textContent).toContain("Enabled");
    expect(row("Deep phase")?.textContent).toContain("Enabled");
    expect(row("REM phase")?.textContent).toContain("Disabled");
  });

  it("shows a slot owner's reported counters in place of memory-core's activity figures", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.reportedEnabled = true;
      payload.dreaming.reportedStats = { promotedToday: 8, promotedTotal: 90 };
    }
    const container = renderOverview({ kind: "ready", payload });
    const rowText = (label: string) =>
      [...container.querySelectorAll(".settings-row")].find((row) =>
        row.textContent?.includes(label),
      )?.textContent;

    expect(rowText("Promoted today")).toContain("8");
    expect(rowText("Promoted total")).toContain("90");
    expect(rowText("Promoted total")).not.toContain("21");
    // A counter the owner leaves out is not filled from memory-core's store.
    expect(rowText("Pending short-term entries")).toContain("n/a");
    expect(rowText("Pending short-term entries")).not.toContain("4");
    // Phase signals stay memory-core's; the section says so while an owner reports.
    expect(container.textContent).toContain("Phase signals and hits are memory-core's own store");
    expect(renderOverview({ kind: "ready", payload: fixturePayload() }).textContent).not.toContain(
      "memory-core's own store",
    );
  });

  it("shows n/a for every owner counter when the report carries no stats", () => {
    // A phases-only or enabled-only report still marks the owner as the one
    // dreaming; memory-core's counters are not shown in its place.
    for (const report of [
      { reportedByProvider: true },
      { reportedByProvider: true, reportedEnabled: true },
    ] as const) {
      const payload = fixturePayload();
      if (payload.dreaming) {
        Object.assign(payload.dreaming, report);
      }
      const container = renderOverview({ kind: "ready", payload });
      const rowText = (label: string) =>
        [...container.querySelectorAll(".settings-row")].find((row) =>
          row.textContent?.includes(label),
        )?.textContent;

      expect(rowText("Promoted today")).toContain("n/a");
      expect(rowText("Promoted total")).toContain("n/a");
      expect(rowText("Promoted total")).not.toContain("21");
      expect(rowText("Pending short-term entries")).toContain("n/a");
      // memory-core's own phase-signal rows keep their figures and are labeled.
      expect(rowText("Phase signals")).toContain("7");
      expect(container.textContent).toContain("Phase signals and hits are memory-core's own store");
    }
  });

  it("schedules a phases-only owner report by each phase's own flag", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      // The owner reported phases but no top-level `enabled`; the host switch is off.
      payload.dreaming.enabled = false;
      payload.dreaming.reportedByProvider = true;
      payload.dreaming.phases.light.enabled = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const row = (name: string) =>
      [...container.querySelectorAll(".settings-row")].find((entry) =>
        entry.textContent?.includes(name),
      );

    expect(row("REM phase")?.textContent).toContain("Enabled");
    expect(row("Deep phase")?.textContent).toContain("Enabled");
    expect(row("Light phase")?.textContent).toContain("Disabled");
  });

  it("explains the phases in sweep order and links to the dreaming guide", () => {
    const container = renderOverview({ kind: "ready", payload: fixturePayload() });
    const phaseRows = [...container.querySelectorAll(".settings-row")].filter((row) =>
      /Light phase|REM phase|Deep phase/.test(row.textContent ?? ""),
    );

    expect(
      phaseRows.map((row) => row.querySelector(".settings-row__title")?.textContent?.trim()),
    ).toEqual(["Light phase", "REM phase", "Deep phase"]);
    expect(phaseRows[0]?.textContent).toContain(
      "Sorts fresh short-term notes and stages promising candidates",
    );
    expect(phaseRows[1]?.textContent).toContain(
      "Reflects on themes and recurring ideas across recent activity",
    );
    expect(phaseRows[2]?.textContent).toContain(
      "promotes the keepers into long-term memory (MEMORY.md), and writes the dream diary",
    );
    expect(phaseRows.every((row) => row.textContent?.includes("0 3 * * *"))).toBe(true);

    const docs = container.querySelector<HTMLAnchorElement>(
      'a[href="https://docs.openclaw.ai/concepts/dreaming"]',
    );
    expect(docs?.textContent).toContain("Open dreaming guide");
    expect(docs?.target).toBe("_blank");
    expect(docs?.rel).toBe("noreferrer noopener");
  });

  it("reports an enabled phase without its managed cron as not scheduled", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.phases.light.managedCronPresent = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const lightRow = [...container.querySelectorAll(".settings-row")].find((row) =>
      row.textContent?.includes("Light phase"),
    );

    expect(lightRow?.textContent).toContain("Not scheduled");
    expect(lightRow?.textContent).not.toContain("Enabled");
    expect(lightRow?.textContent).not.toContain("next ");
  });

  it("offers an inline embedding test before readiness has been checked", () => {
    const payload = fixturePayload();
    payload.embedding = {
      ok: false,
      checked: false,
      error: "run `openclaw memory status --deep` to probe",
    };
    const onProbeEmbeddings = vi.fn();
    const container = renderOverview({ kind: "ready", payload }, undefined, { onProbeEmbeddings });

    expect(container.textContent).toContain("Embedding readiness has not been checked yet.");
    expect(container.textContent).not.toContain("openclaw memory status --deep");
    const testButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton?.disabled).toBe(false);
    testButton?.click();
    expect(onProbeEmbeddings).toHaveBeenCalledOnce();
  });

  it("hides the embedding test once readiness is healthy", () => {
    const container = renderOverview({ kind: "ready", payload: fixturePayload() });

    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent?.trim() === "Test",
      ),
    ).toBe(false);
  });

  it.each([
    { searchRuntimeRegistered: false, error: "memory plugin unavailable", neutral: true },
    { searchRuntimeRegistered: true, error: "search manager failed", neutral: false },
    { searchRuntimeRegistered: undefined, error: "plugin load failed", neutral: false },
  ])("distinguishes absent search support from $error", ({ neutral, ...diagnostic }) => {
    const container = renderOverview({
      kind: "ready",
      payload: {
        agentId: "main",
        searchRuntimeRegistered: diagnostic.searchRuntimeRegistered,
        embedding: { ok: false, error: diagnostic.error },
      },
    });

    expect(container.querySelector(".memory-overview__hero h2")?.textContent).toBe(
      neutral ? "Host memory search is unavailable" : "Memory needs attention",
    );
    expect(container.textContent?.includes("Engine health")).toBe(!neutral);
    expect(container.textContent?.includes(diagnostic.error)).toBe(!neutral);
  });

  it("opens the Memories tab from the overview shortcut", () => {
    const onNavigate = vi.fn();
    const container = renderOverview({ kind: "ready", payload: fixturePayload() }, undefined, {
      onNavigate,
    });

    const shortcut = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Search memories"),
    );
    shortcut?.click();
    expect(onNavigate).toHaveBeenCalledWith("memories");
  });
});
