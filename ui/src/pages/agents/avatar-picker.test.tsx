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
  generate?: AvatarPickerProps["onGenerate"],
  options: Partial<
    Pick<AvatarPickerProps, "agentId" | "footerGeneration" | "onReset" | "onActionsReady">
  > = {},
) {
  vi.spyOn(avatarImage, "svgToAvatarDataUrl").mockResolvedValue({ ok: true, dataUrl: avatar });
  const pending = createDeferred<GeneratedAvatar>();
  const props = {
    ...options,
    agentId: options.agentId ?? "beta",
    avatar: null,
    disabled: false,
    onSelect: vi.fn(),
    onUpload: vi.fn(),
    onGenerate: vi.fn(generate ?? (() => pending.promise)),
  };
  const view = mountSolid(AvatarPicker, props);
  const text = () => view.container.textContent;
  const query = <T extends Element = HTMLElement>(selector: string): T | null =>
    view.container.querySelector<T>(selector);
  const click = (label: string) => {
    const buttons = [...view.container.querySelectorAll("button")];
    const button = buttons.findLast(({ textContent }) => textContent?.trim() === label);
    assert(button, `Missing button: ${label}`);
    button.click();
    flush();
  };
  const describe = (value: string) => {
    click("Generate");
    const input = query<HTMLTextAreaElement>("textarea")!;
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

it("previews generation and requires acceptance before replacing identity", async () => {
  const view = mount("  A patient gardener with a watering can  ");
  expect(view.query(".avatar-picker__ghost .lobster-pet__svg")).not.toBeNull();
  expect(view.text()).toContain("Generating...");
  await view.finish();
  await waitForFast(() => expect(view.text()).toContain("Garden keeper"));
  expect(view.query(".avatar-picker__ghost")).toBeNull();
  expect(view.props.onGenerate).toHaveBeenCalledWith("A patient gardener with a watering can");
  expect(view.props.onSelect).not.toHaveBeenCalled();
  view.click("Discard");
  expect(view.props.onSelect).not.toHaveBeenCalled();
  view.click("Generate");
  await waitForFast(() => expect(view.text()).toContain("Use avatar"));
  view.click("Use avatar");
  expect(view.props.onSelect).toHaveBeenCalledWith(avatar);
});

it("selects a generated avatar directly in the creation dialog and clears busy on reset", async () => {
  const onReset = vi.fn();
  const actionsRef: { current: AvatarPickerActions | null } = { current: null };
  const view = mount(null, undefined, {
    agentId: "new-agent",
    footerGeneration: true,
    onReset,
    onActionsReady: (next) => {
      actionsRef.current = next;
    },
  });
  view.describe("A bright coral claw");
  const actions = actionsRef.current;
  assert(actions);
  const generation = actions.generate();
  flush();
  expect(actions.footerState().busy).toBe(true);
  await view.finish();
  await generation;
  await waitForFast(() => expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith(avatar));
  expect(actions.footerState().generated).toBe(true);
  expect(actions.footerState().busy).toBe(false);
  actions.reset();
  flush();
  expect(actions.footerState().generated).toBe(false);
  expect(onReset).toHaveBeenCalledOnce();
});

it("retires generation on disposal", async () => {
  const view = mount();
  view.dispose();
  await view.finish();
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

it.each(["success", "failure"] as const)(
  "lets a replacement generation settle before retired work (%s)",
  async (outcome) => {
    const retired = createDeferred<GeneratedAvatar>();
    const replacement = { ...generated, name: "New garden keeper" };
    const generate = vi.fn().mockReturnValueOnce(retired.promise).mockResolvedValue(replacement);
    const view = mount(null, generate);
    view.describe("Old explorer");
    view.click("Generate");
    view.click("Blobster");
    view.describe("New gardener");
    view.click("Generate");
    await waitForFast(() => expect(view.text()).toContain(replacement.name));
    if (outcome === "success") {
      retired.resolve(generated);
    } else {
      retired.reject(new Error("Retired generation failed."));
    }
    await retired.promise.catch(() => undefined);
    await Promise.resolve();
    flush();
    expect(view.text()).toContain(replacement.name);
    expect(view.query('[role="alert"]')).toBeNull();
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
    view.query<HTMLButtonElement>(".avatar-picker__preset")!.click();
    flush();
  };
  selectPreset();
  expect(view.query('[role="status"]')).not.toBeNull();
  expect(view.props.onSelect).not.toHaveBeenCalled();
  prepared.resolve(document.createElement("img"));
  await waitForFast(() => expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith(avatar));
  selectPreset();
  view.describe("A gardener");
  view.click("Generate");
  await view.finish();
  await waitForFast(() => expect(view.text()).toContain("Use avatar"));
  retired.resolve(document.createElement("img"));
  await retired.promise;
  await Promise.resolve();
  flush();
  expect(view.props.onSelect).toHaveBeenCalledTimes(1);
  expect(view.text()).toContain(generated.name);
});

it("clears a failed preparation while a retry is pending and keeps its controls", async () => {
  const retry = createDeferred<GeneratedAvatar>();
  const generate = vi
    .fn()
    .mockRejectedValueOnce(new Error("Synthetic failure."))
    .mockReturnValue(retry.promise);
  const view = mount(null, generate);
  view.describe("A gardener");
  view.click("Generate");
  await waitForFast(() =>
    expect(view.query('[role="alert"]')?.textContent).toContain("Synthetic failure"),
  );
  const prompt = view.query("textarea");
  view.click("Generate");
  expect(view.query('[role="alert"]')).toBeNull();
  expect(view.query("textarea")).toBe(prompt);
  expect(view.text()).toContain("Generating...");
  retry.resolve(generated);
  await waitForFast(() => expect(view.text()).toContain("Use avatar"));
  expect(view.query('[role="alert"]')).toBeNull();
  expect(view.query("textarea")).toBe(prompt);
  expect(view.props.onSelect).not.toHaveBeenCalled();
});
