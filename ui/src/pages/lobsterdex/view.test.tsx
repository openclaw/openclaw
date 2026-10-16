/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLobsterdexEntries, recordLobsterVisit } from "../../components/lobster-dex.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { LobsterdexView } from "./view.tsx";

type ViewProps = Parameters<typeof LobsterdexView>[0];
function render(props: ViewProps, container: HTMLElement) {
  let setProps!: (props: ViewProps) => void;
  const view = mountSolid(
    () => {
      const [state, setState] = createSignal(props);
      setProps = setState;
      return <LobsterdexView {...state()} />;
    },
    { container },
  );
  flush();
  return {
    ...view,
    update(next: ViewProps) {
      setProps(next);
      flush();
    },
  };
}

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
    render({ entries }, container);

    expect(container.querySelector(".lobsterdex-page__count")?.textContent).toBe("1/49 visited");

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

  it.each([
    [
      "clawnstantine",
      "Clawnstantine",
      "All tides lead here.",
      "Built an empire. Still rules from the ledge.",
    ],
    [
      "clawiestardust",
      "Clawie Stardust",
      "Something electric washed ashore.",
      "Changes shells. Never changes style.",
    ],
    [
      "taylorpinch",
      "Taylor Pinch",
      "Someone is shaking off the sand.",
      "Turns every tide into an era.",
    ],
    [
      "clawtoodeetoo",
      "Clawtoo Deetoo",
      "A resourceful little droid.",
      "Speaks fluent beep. Fixes things anyway.",
    ],
    [
      "leonardodepinchy",
      "Leonardo DaPinchy",
      "A little Renaissance is washing ashore.",
      "Every shell is a canvas.",
    ],
    ["shellvis", "Shellvis", "Someone brought blue suede claws.", "The king of rock and claw."],
    [
      "alexandergrahamshell",
      "Alexander Graham Shell",
      "A familiar ringing from the shore.",
      "Good ideas ring a bell.",
    ],
  ] as const)(
    "discovers %s by palette, not an existing visitor name, and retains shiny sightings",
    (id, name, hint, flavor) => {
      const container = document.createElement("div");
      // Names are not palette identity. Remembered visitors must neither
      // reveal the new palette nor be renamed by it.
      recordLobsterVisit("crimson", { name });
      const view = render({ entries: getLobsterdexEntries() }, container);
      const card = () => container.querySelector(`#lobsterdex-${id}`);
      expect(card()?.querySelector("h3")?.textContent).toBe("?");
      expect(card()?.textContent).toContain(hint);

      recordLobsterVisit(id, { name, shiny: true });
      recordLobsterVisit(id, { name: "Impostor" });
      view.update({ entries: getLobsterdexEntries() });
      expect(card()?.querySelector("h3")?.textContent).toBe(name);
      expect(getLobsterdexEntries().get("crimson")?.name).toBe(name);
      expect(card()?.textContent).toContain(flavor);
      expect(card()?.querySelector(`.lob-${id}`)).not.toBeNull();
      expect(card()?.querySelector(".lobsterdex-page__star")).not.toBeNull();
      expect(card()?.querySelectorAll("time")).toHaveLength(2);
      expect(card()?.classList.contains("lobsterdex-page__card--unseen")).toBe(false);
    },
  );
});
