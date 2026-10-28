import { flush } from "solid-js";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import * as avatarImage from "./avatar-image.ts";
import {
  AvatarPicker,
  type AvatarPickerActions,
  type AvatarPickerProps,
  type GeneratedAvatar,
} from "./avatar-picker.tsx";

const avatar = "data:image/webp;base64,YXZhdGFy";
const generated = { name: "Garden keeper", description: "A tiny gardener.", svg: "<svg/>" };

afterEach(() => vi.restoreAllMocks());

function mount(
  prompt: string | null = "Explorer",
  error?: Error,
  generate?: AvatarPickerProps["onGenerate"],
) {
  vi.spyOn(avatarImage, "svgToAvatarDataUrl").mockResolvedValue({ ok: true, dataUrl: avatar });
  const pending = createDeferred<GeneratedAvatar>();
  const props = {
    agentId: "beta",
    avatar: null,
    disabled: false,
    onSelect: vi.fn(),
    onUpload: vi.fn(),
    onGenerate: vi.fn(generate ?? (() => (error ? Promise.reject(error) : pending.promise))),
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
  const describe = (value: string) => {
    click("Generate");
    const input = view.container.querySelector("textarea")!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
  };
  if (prompt !== null) {
    describe(prompt);
    click("Generate");
  }
  const finish = async () => {
    pending.resolve(generated);
    await pending.promise;
    await Promise.resolve();
    flush();
  };
  return { ...view, props, click, text, query, finish, describe };
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

it("selects a generated avatar directly in the creation dialog and clears busy on reset", async () => {
  vi.spyOn(avatarImage, "svgToAvatarDataUrl").mockResolvedValue({ ok: true, dataUrl: avatar });
  const pending = createDeferred<GeneratedAvatar>();
  const onSelect = vi.fn();
  const onReset = vi.fn();
  const actionsRef: { current: AvatarPickerActions | null } = { current: null };
  const view = mountSolid(AvatarPicker, {
    agentId: "new-agent",
    avatar: null,
    disabled: false,
    footerGeneration: true,
    onSelect,
    onReset,
    onActionsReady: (next) => {
      actionsRef.current = next;
    },
    onUpload: vi.fn(),
    onGenerate: () => pending.promise,
  });
  const generateTab = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Generate",
  );
  assert(generateTab);
  generateTab.click();
  flush();
  const prompt = view.container.querySelector("textarea")!;
  prompt.value = "A bright coral claw";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  const actions = actionsRef.current;
  assert(actions);
  const generation = actions.generate();
  flush();
  expect(actions.footerState().busy).toBe(true);
  pending.resolve(generated);
  await generation;
  await waitForFast(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith(avatar));
  expect(actions.footerState().generated).toBe(true);
  expect(actions.footerState().busy).toBe(false);
  actions.reset();
  flush();
  expect(actions.footerState().generated).toBe(false);
  expect(onReset).toHaveBeenCalledOnce();
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

it.each(["unusable", "too-detailed"] as const)(
  "shows %s image results without publishing a generated avatar",
  async (reason) => {
    const view = mount();
    vi.mocked(avatarImage.svgToAvatarDataUrl).mockResolvedValue({ ok: false, reason });
    await view.finish();
    await waitForFast(() =>
      expect(view.query('[role="alert"]')?.textContent).toContain(
        reason === "too-detailed" ? "too detailed" : "That image can't be used",
      ),
    );
    expect(view.props.onSelect).not.toHaveBeenCalled();
    expect(view.query(".avatar-picker__candidate")).toBeNull();
  },
);

it("shows generation failures without changing the selected avatar", async () => {
  const view = mount("Explorer", new Error("No model"));
  await waitForFast(() => expect(view.query('[role="alert"]')?.textContent).toContain("No model"));
  expect(view.props.onSelect).not.toHaveBeenCalled();
});

it.each(["success", "failure"] as const)(
  "lets a replacement generation settle before retired work (%s)",
  async (outcome) => {
    const retired = createDeferred<GeneratedAvatar>();
    const replacement = { ...generated, name: "New garden keeper" };
    const generate = vi.fn().mockReturnValueOnce(retired.promise).mockResolvedValue(replacement);
    const view = mount(null, undefined, generate);
    view.describe("Old explorer");
    view.click("Generate");
    view.click("Blobster");
    view.describe("New gardener");
    view.click("Generate");
    await waitForFast(() => expect(view.container.textContent).toContain(replacement.name));
    if (outcome === "success") {
      retired.resolve(generated);
    } else {
      retired.reject(new Error("Retired generation failed."));
    }
    await retired.promise.catch(() => undefined);
    await Promise.resolve();
    flush();
    expect(view.container.textContent).toContain(replacement.name);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.props.onSelect).not.toHaveBeenCalled();
    view.click("Use avatar");
    expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith(avatar);
  },
);

it("prepares a confirmed preset without publishing a retired preparation", async () => {
  const lobsterImage = await import("../../components/lobster-image.ts");
  const prepared = createDeferred<HTMLImageElement | null>();
  const retired = createDeferred<HTMLImageElement | null>();
  vi.spyOn(lobsterImage, "loadLobsterImage")
    .mockReturnValueOnce(prepared.promise)
    .mockReturnValueOnce(retired.promise);
  vi.spyOn(avatarImage, "imageToAvatarDataUrl").mockReturnValue({ ok: true, dataUrl: avatar });
  const view = mount(null);
  const selectPreset = () => {
    view.container.querySelector<HTMLButtonElement>(".avatar-picker__preset")!.click();
    flush();
  };
  selectPreset();
  expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  expect(view.props.onSelect).not.toHaveBeenCalled();
  prepared.resolve(document.createElement("img"));
  await waitForFast(() => expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith(avatar));
  selectPreset();
  view.describe("A gardener");
  view.click("Generate");
  await view.finish();
  await waitForFast(() => expect(view.container.textContent).toContain("Use avatar"));
  retired.resolve(document.createElement("img"));
  await retired.promise;
  await Promise.resolve();
  flush();
  expect(view.props.onSelect).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).toContain(generated.name);
});

it("clears a failed preparation while a retry is pending and keeps its controls", async () => {
  const retry = createDeferred<GeneratedAvatar>();
  const generate = vi
    .fn()
    .mockRejectedValueOnce(new Error("Synthetic failure."))
    .mockReturnValue(retry.promise);
  const view = mount(null, undefined, generate);
  view.describe("A gardener");
  view.click("Generate");
  await waitForFast(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic failure",
    ),
  );
  const prompt = view.container.querySelector("textarea");
  view.click("Generate");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.querySelector("textarea")).toBe(prompt);
  expect(view.container.textContent).toContain("Generating...");
  retry.resolve(generated);
  await waitForFast(() => expect(view.container.textContent).toContain("Use avatar"));
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.querySelector("textarea")).toBe(prompt);
});
