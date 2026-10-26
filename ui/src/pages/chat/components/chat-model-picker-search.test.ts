/* @vitest-environment jsdom */
import { createEffect, createRoot, createSignal } from "solid-js";
import { expect, it } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createChatModelSearchView, updateModelSearch } from "./chat-model-picker-search-view.ts";
import { createChatModelSearch, type ChatModelSearchCatalog } from "./chat-model-picker-search.ts";

it("only invalidates model row metadata when the ranked result changes", () => {
  const catalog: ChatModelSearchCatalog = {
    providers: [],
    lists: ["models"],
    rows: Array.from({ length: 1_000 }, (_, index) => ({
      key: `model-${index}`,
      list: "models",
      name: `model ${String(index).padStart(4, "0")}`,
      providerLabel: "example",
      reference: `example/model-${index}`,
      disabled: false,
      selected: false,
      hasShortcut: true,
    })),
  };
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
  } finally {
    fixture.dispose();
  }
});
