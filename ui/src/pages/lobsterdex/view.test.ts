/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLobsterdexEntries, recordLobsterVisit } from "../../components/lobster-dex.ts";
import { i18n } from "../../i18n/index.ts";
import { renderLobsterdex } from "./view.ts";

describe("renderLobsterdex", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    vi.stubGlobal("localStorage", window.localStorage);
    await i18n.setLocale("en");
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders discovered lore, first visit, hidden hints, and the count", () => {
    const firstSeenAt = new Date("2026-07-10T12:00:00.000Z").getTime();
    const entries = new Map([
      ["crimson", { firstSeenAt, name: "Ruby", shinySeenAt: firstSeenAt }] as const,
    ]);
    const container = document.createElement("div");
    render(renderLobsterdex(entries), container);

    expect(container.querySelector(".lobsterdex-page__count")?.textContent).toBe("1/43 visited");

    const seen = container.querySelector(".lobster-pet--palette-crimson")?.closest("article");
    expect(seen?.id).toBe("lobsterdex-crimson");
    expect(seen?.querySelector("h3")?.textContent).toBe("Ruby");
    expect(seen?.querySelector(".lobsterdex-page__lore")?.textContent).toBe(
      "The classic red, first in every tide pool.",
    );
    expect(seen?.querySelector(".lobsterdex-page__date")?.textContent).toContain(
      new Date(firstSeenAt).toLocaleDateString("en"),
    );
    expect(seen?.querySelectorAll(".lobsterdex-page__date")).toHaveLength(2);
    expect(seen?.querySelector(".lobsterdex-page__dates")?.textContent).toContain(
      `✦ Shiny spotted ${new Date(firstSeenAt).toLocaleDateString("en")}`,
    );
    expect(seen?.querySelector(".lobsterdex-page__star")).not.toBeNull();
    expect(seen?.querySelector('button[aria-label="Copy link"]')).not.toBeNull();

    const unseen = container.querySelector(".lobster-pet--palette-watermelon")?.closest("article");
    expect(unseen?.querySelector("h3")?.textContent).toBe("?");
    expect(unseen?.querySelector(".lobsterdex-page__lore")?.textContent).toBe("Ripe when thumped.");
    expect(unseen?.querySelector(".lobsterdex-page__date")).toBeNull();
  });

  it("reveals Clawnstantine after a recorded visit and preserves the first shiny sighting", () => {
    const container = document.createElement("div");
    const renderDex = () => render(renderLobsterdex(getLobsterdexEntries()), container);
    renderDex();
    const card = () => container.querySelector("#lobsterdex-clawnstantine");
    expect(card()?.querySelector("h3")?.textContent).toBe("?");
    expect(card()?.textContent).toContain("All tides lead here.");

    recordLobsterVisit("clawnstantine", { name: "Clawnstantine", shiny: true });
    recordLobsterVisit("clawnstantine", { name: "Impostor" });
    renderDex();
    expect(card()?.querySelector("h3")?.textContent).toBe("Clawnstantine");
    expect(card()?.textContent).toContain("Built an empire. Still rules from the ledge.");
    expect(card()?.querySelector(".lob-clawnstantine__laurel")).not.toBeNull();
    expect(card()?.querySelector(".lobsterdex-page__star")).not.toBeNull();
    expect(card()?.querySelectorAll("time")).toHaveLength(2);
    expect(card()?.classList.contains("lobsterdex-page__card--unseen")).toBe(false);
  });
});
