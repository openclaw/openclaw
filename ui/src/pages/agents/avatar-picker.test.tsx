import { flush } from "solid-js";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import * as avatarImage from "./avatar-image.ts";
import { AvatarPicker, type GeneratedAvatar } from "./avatar-picker.tsx";

const avatar = "data:image/webp;base64,YXZhdGFy";
const generated = { name: "Garden keeper", description: "A tiny gardener.", svg: "<svg/>" };

afterEach(() => vi.restoreAllMocks());

function mount(prompt: string | null = "Explorer", error?: Error) {
  vi.spyOn(avatarImage, "svgToAvatarDataUrl").mockResolvedValue({ ok: true, dataUrl: avatar });
  const pending = createDeferred<GeneratedAvatar>();
  const props = {
    agentId: "beta",
    avatar: null,
    disabled: false,
    onSelect: vi.fn(),
    onUpload: vi.fn(),
    onGenerate: vi.fn(() => (error ? Promise.reject(error) : pending.promise)),
  };
  const view = mountSolid(AvatarPicker, props);
  const text = () => view.container.textContent;
  const query = (selector: string) => view.container.querySelector(selector);
  const click = (label: string) => {
    const buttons = [...view.container.querySelectorAll("button")];
    const button = buttons.findLast(({ textContent }) => textContent?.trim() === label);
    assert(button, `Missing button: ${label}`);
    button.click();
    flush();
  };
  if (prompt !== null) {
    click("Generate");
    const input = view.container.querySelector("textarea")!;
    input.value = prompt;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    click("Generate");
  }
  const finish = async () => {
    pending.resolve(generated);
    await pending.promise;
    await Promise.resolve();
    flush();
  };
  return { ...view, props, click, text, query, finish };
}

it("offers bundled character presets without a Lobsterdex collection", () => {
  const view = mount(null);
  for (const name of ["Clawnstantine", "Clawie Stardust", "24K"]) {
    const preset = view.query(`.avatar-picker__preset[aria-label="${name}"]`);
    expect(preset).toMatchObject({ disabled: false });
  }
  expect(view.container.querySelectorAll(".avatar-picker__preset:disabled")).toHaveLength(0);
});

it("previews generation and requires acceptance before replacing identity", async () => {
  const view = mount("  A patient gardener with a watering can  ");
  expect(view.query(".avatar-picker__ghost .lobster-pet__svg")).not.toBeNull();
  expect(view.text()).toContain("Generating...");
  await view.finish();
  await waitForFast(() => expect(view.text()).toContain("Garden keeper"));
  expect(view.query(".avatar-picker__ghost")).toBeNull();
  expect(view.props.onGenerate).toHaveBeenCalledWith("A patient gardener with a watering can");
  expect(view.props.onSelect).not.toHaveBeenCalled();
  expect(view.text()).not.toMatch(/Generate again|Chat and sidebar preview/);
  const actions = [...view.query(".avatar-picker__actions")!.children];
  expect(actions.map((button) => button.textContent?.trim())).toEqual(["Discard", "Use avatar"]);
  view.click("Discard");
  expect(view.props.onSelect).not.toHaveBeenCalled();
  view.click("Generate");
  await waitForFast(() => expect(view.text()).toContain("Use avatar"));
  view.click("Use avatar");
  expect(view.props.onSelect).toHaveBeenCalledWith(avatar);
});

it.each(["mode change", "disposal"])("retires generation on %s", async (reason) => {
  const view = mount();
  const retire = reason === "disposal" ? view.dispose : () => view.click("Blobster");
  retire();
  await view.finish();
  if (reason === "mode change") {
    view.click("Generate");
  }
  expect(view.text()).not.toContain("Use avatar");
  expect(view.props.onSelect).not.toHaveBeenCalled();
});

it("shows generation failures without changing the selected avatar", async () => {
  const view = mount("Explorer", new Error("No model"));
  await waitForFast(() => expect(view.query('[role="alert"]')?.textContent).toContain("No model"));
  expect(view.props.onSelect).not.toHaveBeenCalled();
});
