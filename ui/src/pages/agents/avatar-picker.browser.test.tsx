import { expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { AvatarPicker } from "./avatar-picker.tsx";

it("wraps long avatar descriptions inside a narrow picker", async () => {
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;width:390px;overflow:auto";
  document.body.append(container);
  const mounted = mountSolid(
    AvatarPicker,
    {
      agentId: "gardener",
      avatar: null,
      disabled: false,
      onSelect: () => undefined,
      onUpload: () => undefined,
      onGenerate: async () => ({ name: "", description: "", svg: "" }),
    },
    container,
  );
  try {
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const prompt = page.getByRole("textbox", { name: "Describe your blobster...", exact: true });
    const description =
      "A gentle garden keeper with a watering can and a leafy sprout.\n" + "leaf".repeat(80);
    await prompt.fill(description);
    const input = prompt.element();
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error("Missing avatar description textarea");
    }
    expect(input.value).toBe(description);
    expect(input.clientWidth).toBeLessThan(390);
    expect(getComputedStyle(input).whiteSpace).toBe("pre-wrap");
    expect(input.scrollWidth).toBeLessThanOrEqual(input.clientWidth);
  } finally {
    mounted.dispose();
    container.remove();
  }
});
