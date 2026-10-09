import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { expect, it } from "vitest";
import { SolidSmoke } from "./solid-smoke.tsx";

it("mounts, updates Solid and a Lit property binding, then disposes", async () => {
  const view = render(() => <SolidSmoke />);
  try {
    const card = view.container.querySelector("openclaw-option-card");
    if (!card) {
      throw new Error("Solid did not mount the Lit option card");
    }
    await card.updateComplete;
    expect(view.getByText("No entries")).toBeTruthy();
    expect(view.container.querySelector("output")?.textContent).toBe("Count: 0");
    expect(card.querySelector(".option-card__question")?.textContent).toBe("Count: 0");
    expect(card.hasAttribute("props")).toBe(false);

    fireEvent.click(view.getByRole("button", { name: "Increment" }));
    flush();
    await card.updateComplete;
    expect(view.queryByText("No entries")).toBeNull();
    expect(view.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Entry 1"]);
    expect(view.container.querySelector("output")?.textContent).toBe("Count: 1");
    expect(card.querySelector(".option-card__question")?.textContent).toBe("Count: 1");

    fireEvent.click(view.getByRole("button", { name: "Increment" }));
    flush();
    await card.updateComplete;
    expect(view.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Entry 1",
      "Entry 2",
    ]);
    expect(card.querySelector(".option-card__question")?.textContent).toBe("Count: 2");
  } finally {
    cleanup();
  }
  expect(view.container.childNodes).toHaveLength(0);
});
