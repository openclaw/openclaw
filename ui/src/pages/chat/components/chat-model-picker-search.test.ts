/* @vitest-environment jsdom */
import { createEffect, createRoot, createSignal } from "solid-js";
import { expect, it } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createChatModelSearchView, updateModelSearch } from "./chat-model-picker-search-view.ts";
import { createChatModelSearch, type ChatModelSearchCatalog } from "./chat-model-picker-search.ts";

it("keeps canonical search ranks and highlight invalidation local", () => {
  const catalog: ChatModelSearchCatalog = {
    providers: [],
    lists: ["models"],
    rows: Array.from({ length: 1_000 }, (_, index) => {
      const accent = index % 2 === 0 ? "Mu\u0308nchen" : "M\u00fcnchen";
      return {
        key: index === 8 ? "account:personal" : `model-${index}`,
        list: "models",
        name: `model ${String(index).padStart(4, "0")}${index === 6 || index === 7 ? ` ${accent}` : ""}`,
        ...(index === 4 || index === 5 ? { keywords: accent } : {}),
        providerLabel: index === 2 || index === 3 ? accent : "example",
        reference: `example/${index < 2 ? accent : `model-${index}`}`,
        disabled: false,
        selected: false,
        hasShortcut: true,
      };
    }),
  };
  const originalRows = catalog.rows.slice(0, 8).map((row) => Object.assign({}, row));
  const ranked = [6, 7, 4, 5, 2, 3, 0, 1].map((index) => originalRows[index]);
  const keys = ["model-0", "model-1", "account:personal"];
  const highlightReads = [0, 0, 0];
  const fixture = createRoot((dispose) => {
    const [source, update] = createSignal(catalog);
    const search = createChatModelSearch();
    const details = document.createElement("details");
    details.className = "chat-controls__model-picker";
    const input = document.createElement("input");
    details.append(input);
    search.detailsRef(details);
    const view = createChatModelSearchView(search, source, () => {});
    let reads = 0;
    for (const row of catalog.rows) {
      createEffect(
        () => {
          reads += 1;
          return view.row(row.key).rank;
        },
        () => {},
      );
    }
    keys.forEach((key, index) => {
      createEffect(
        () => {
          highlightReads[index]!++;
          return search.isHighlighted(key);
        },
        () => {},
      );
    });
    return {
      dispose,
      view,
      update,
      query(value: string) {
        input.value = value;
        updateModelSearch(input);
      },
      reads: () => reads,
    };
  });
  try {
    flush();
    const initialReads = fixture.reads();
    for (const query of ["m", "mo", "mod", "mode", "model"]) {
      fixture.query(query);
      flush();
    }
    expect(fixture.view.matches()).toHaveLength(1_000);
    expect(fixture.reads() - initialReads).toBe(0);

    // A refreshed row's unrelated selection fact must not invalidate its rank.
    fixture.update({
      ...catalog,
      rows: catalog.rows.map((row) =>
        Object.assign({}, row, { selected: row.key === "model-999" }),
      ),
    });
    flush();
    expect(fixture.reads() - initialReads).toBe(0);

    fixture.query("model 0999");
    flush();
    expect(fixture.view.row("model-999")).toMatchObject({
      hidden: false,
      rank: 0,
      shortcut: 1,
      position: 1,
      size: 1,
    });
    expect(fixture.view.row("model-0").hidden).toBe(true);
    expect(fixture.reads() - initialReads).toBe(1_000);

    for (const query of ["M\u00dcNCHEN", "MU\u0308NCHEN"]) {
      fixture.query(query);
      flush();
      expect.soft(fixture.view.matches().map(({ row }) => row)).toEqual(ranked);
    }
    fixture.query("munchen");
    flush();
    expect(fixture.view.matches()).toEqual([]);

    fixture.query("");
    flush();
    fixture.view.highlight(keys[0]);
    flush();
    highlightReads.fill(0);
    fixture.view.highlight(keys[1]);
    flush();
    expect(highlightReads).toEqual([1, 1, 0]);
    expect(keys.map(fixture.view.isHighlighted)).toEqual([false, true, false]);

    fixture.view.highlight(keys[2]);
    flush();
    expect(highlightReads).toEqual([1, 2, 1]);
    expect(keys.map(fixture.view.isHighlighted)).toEqual([false, false, true]);

    fixture.view.highlight(undefined);
    flush();
    expect(highlightReads).toEqual([1, 2, 2]);
    expect(keys.map(fixture.view.isHighlighted)).toEqual([false, false, false]);
  } finally {
    fixture.dispose();
  }
});
