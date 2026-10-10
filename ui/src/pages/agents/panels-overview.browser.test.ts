import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

it("opens agent avatar selection from the keyboard and respects the busy state", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const props = createAgentViewTestProps();
  const mounted = mountSolid(Agents, props, container);
  try {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error("Missing avatar file input");
    }
    const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});
    const upload = page.getByRole("button", { name: "Choose image…", exact: true });
    const button = upload.element();
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Avatar upload must use a native button");
    }
    button.focus();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(openPicker).toHaveBeenCalledTimes(2);

    mounted.update({ ...props, overview: { ...props.overview, identitySaving: true } });
    expect(button.disabled).toBe(true);
    button.click();
    expect(openPicker).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    mounted.dispose();

    container.remove();
  }
});
