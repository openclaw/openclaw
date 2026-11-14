import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  runWizardWithPromptNavigation,
  runWizardWithPromptNavigationScope,
} from "./navigation-prompter.js";
import type { WizardPrompter } from "./prompts.js";
import { WizardNavigationError } from "./prompts.js";

function pick(prompter: WizardPrompter, message: string, values: string[]) {
  return prompter.select({ message, options: values.map((value) => ({ value, label: value })) });
}

const back = new WizardNavigationError("back");
const forward = new WizardNavigationError("forward");

function scriptedSelect(...answers: Array<string | WizardNavigationError>) {
  return vi.fn(async () => {
    const answer = expectDefined(answers.shift(), "scripted answer");
    if (answer instanceof WizardNavigationError) {
      throw answer;
    }
    return answer;
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

it.each(["replace", "forward"])("replays answers with %s navigation", async (action) => {
  const replacing = action === "replace";
  const script = replacing
    ? ["alpha", back, "beta", "two"]
    : ["alpha", "two", back, forward, "final"];
  const expected = replacing ? ["beta", "two"] : ["alpha", "two", "final"];
  const note = vi.fn(async () => {});
  const select = scriptedSelect(...script);
  const result = await navigate({ note, select }, async (prompter) => {
    const answers = [];
    for (const message of ["First", "Second", "Third"].slice(0, expected.length)) {
      answers.push(await pick(prompter, message, ["alpha", "beta", "one", "two", "final"]));
      if (message !== "Third") {
        await prompter.note(`after ${message}`);
      }
    }
    return answers;
  });
  expect(result).toEqual(expected);
  expect(selectParamsAt(select, replacing ? 2 : 3)).toMatchObject({
    message: replacing ? "First" : "Second",
    initialValue: replacing ? "alpha" : "two",
    navigation: { canGoBack: !replacing, canGoForward: true },
  });
  expect(selectParamsAt(select, script.length - 1).navigation).toEqual({
    canGoBack: true,
    canGoForward: false,
  });
  const notes = replacing
    ? ["after First", "after First", "after Second"]
    : ["after First", "after Second", "after Second"];
  expect(note.mock.calls).toEqual(notes.map((message) => [message, undefined]));
});

it("does not cache sensitive text answers for forward navigation", async () => {
  const select = scriptedSelect(back, "done");
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
  const select = scriptedSelect("alpha", back);
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
  const select = scriptedSelect(back);
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
