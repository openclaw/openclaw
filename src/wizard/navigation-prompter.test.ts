import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  runWizardWithPromptNavigation,
  runWizardWithPromptNavigationScope,
} from "./navigation-prompter.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";
import { WizardNavigationError } from "./prompts.js";

function pick(prompter: WizardPrompter, message: string, values: string[]) {
  return prompter.select({ message, options: values.map((value) => ({ value, label: value })) });
}

function scriptedSelect(...steps: Array<[string, string | WizardNavigationError]>) {
  return vi.fn(async (params: WizardSelectParams) => {
    const step = steps.shift();
    if (!step) {
      throw new Error(`unexpected prompt ${params.message}`);
    }
    expect(params.message).toBe(step[0]);
    if (step[1] instanceof WizardNavigationError) {
      throw step[1];
    }
    return step[1];
  }) as unknown as WizardPrompter["select"];
}

function selectParamsAt(select: WizardPrompter["select"], index: number) {
  return expectDefined(vi.mocked(select).mock.calls[index]?.[0], `missing select call ${index}`);
}

async function navigate<T>(
  overrides: Partial<WizardPrompter>,
  run: (prompter: WizardPrompter) => Promise<T>,
) {
  let result: T | undefined;
  await runWizardWithPromptNavigation(createWizardPrompter(overrides), async (prompter) => {
    result = await run(prompter);
  });
  return result;
}

it("restarts at the previous prompt when back is requested", async () => {
  const select = scriptedSelect(
    ["First", "alpha"],
    ["Second", new WizardNavigationError("back")],
    ["First", "beta"],
    ["Second", "two"],
  );
  const result = await navigate({ select }, async (prompter) => ({
    first: await pick(prompter, "First", ["alpha", "beta"]),
    second: await pick(prompter, "Second", ["one", "two"]),
  }));
  expect(result).toEqual({ first: "beta", second: "two" });
  expect([2, 3].map((index) => selectParamsAt(select, index).navigation)).toEqual([
    { canGoBack: false, canGoForward: true },
    { canGoBack: true, canGoForward: false },
  ]);
});

it("uses right navigation to accept a remembered prompt answer", async () => {
  const note = vi.fn(async () => {});
  const select = scriptedSelect(
    ["First", "alpha"],
    ["Second", "two"],
    ["Third", new WizardNavigationError("back")],
    ["Second", new WizardNavigationError("forward")],
    ["Third", "final"],
  );
  const result = await navigate({ note, select }, async (navigationPrompter) => {
    const first = await pick(navigationPrompter, "First", ["alpha"]);
    await navigationPrompter.note("after first");
    const second = await pick(navigationPrompter, "Second", ["one", "two"]);
    await navigationPrompter.note("after second");
    const third = await pick(navigationPrompter, "Third", ["final"]);
    return { first, second, third };
  });
  expect(result).toEqual({ first: "alpha", second: "two", third: "final" });
  expect(selectParamsAt(select, 3)).toMatchObject({
    message: "Second",
    initialValue: "two",
    navigation: { canGoBack: true, canGoForward: true },
  });
  expect(note.mock.calls).toEqual([
    ["after first", undefined],
    ["after second", undefined],
    ["after second", undefined],
  ]);
});

it("does not cache sensitive text answers for forward navigation", async () => {
  const select = scriptedSelect(["Done", new WizardNavigationError("back")], ["Done", "done"]);
  const text = vi
    .fn<WizardPrompter["text"]>()
    .mockResolvedValueOnce("secret-one")
    .mockResolvedValueOnce("secret-two");
  const result = await navigate({ select, text }, async (prompter) => ({
    secret: await prompter.text({ message: "Secret", sensitive: true }),
    done: await pick(prompter, "Done", ["done"]),
  }));
  expect(result).toEqual({ secret: "secret-two", done: "done" });
  expect(text.mock.calls[1]?.[0]).toMatchObject({
    message: "Secret",
    navigation: { canGoBack: false, canGoForward: false },
  });
});

it("disables back replay for prompts after an irreversible boundary", async () => {
  const select = scriptedSelect(["First", "alpha"], ["Second", new WizardNavigationError("back")]);
  await expect(
    navigate({ select }, async (navigationPrompter) => {
      await pick(navigationPrompter, "First", ["alpha"]);
      navigationPrompter.disableBackNavigation?.();
      await pick(navigationPrompter, "Second", ["two"]);
    }),
  ).rejects.toMatchObject({ direction: "back" });
  expect(selectParamsAt(select, 1).navigation).toEqual({
    canGoBack: false,
    canGoForward: false,
  });
});
it("creates a fresh scope inside an outer wizard whose back history is disabled", async () => {
  const select = vi.fn(async () => {
    throw new WizardNavigationError("back");
  }) as unknown as WizardPrompter["select"];
  const outcome = await navigate({ select }, async (outerPrompter) => {
    outerPrompter.disableBackNavigation?.();
    return await runWizardWithPromptNavigationScope(outerPrompter, async (scopedPrompter) => {
      await pick(scopedPrompter, "First channel prompt", ["continue"]);
      return "completed";
    });
  });
  expect(outcome).toEqual({ status: "back" });
  expect(selectParamsAt(select, 0).navigation).toEqual({
    canGoBack: true,
    canGoForward: false,
  });
});

it("preserves optional client actions inside a navigation scope", async () => {
  const deviceCode = vi.fn(async () => undefined);
  const openUrl = vi.fn(async () => undefined);
  const prompter = createWizardPrompter({ deviceCode, openUrl });
  const outcome = await runWizardWithPromptNavigationScope(prompter, async (scopedPrompter) => {
    await scopedPrompter.deviceCode?.({ title: "Link device", code: "ABCD" });
    await scopedPrompter.openUrl?.("https://example.com/link");
    return "completed";
  });
  expect(outcome).toEqual({ status: "completed", value: "completed" });
  expect(deviceCode).toHaveBeenCalledWith({ title: "Link device", code: "ABCD" });
  expect(openUrl).toHaveBeenCalledWith("https://example.com/link");
});
