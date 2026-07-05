// Wizard prompter test helper provides mocked wizard prompt responses.
import { vi } from "vitest";
import type { WizardPrompter } from "../../src/wizard/prompts.js";

// Vitest mock prompter for wizard tests.

/** Create a WizardPrompter with default mocked responses and optional overrides. */
<<<<<<< HEAD
export function createWizardPrompter(
  overrides?: Partial<WizardPrompter>,
  options?: { defaultSelect?: string },
): WizardPrompter {
  const select = vi.fn(
    async () => options?.defaultSelect ?? "quickstart",
  ) as unknown as WizardPrompter["select"];
=======
export function createWizardPrompter(overrides?: Partial<WizardPrompter>): WizardPrompter {
  const select = vi.fn(async () => "quickstart") as unknown as WizardPrompter["select"];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select,
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}
