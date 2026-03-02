import { vi } from "vitest";
import type { WizardProgress, WizardPrompter } from "../../src/wizard/prompts.js";

export function createWizardPrompter(overrides?: Partial<WizardPrompter>): WizardPrompter {
  const noopProgress: WizardProgress = {
    update: () => {},
    stop: () => {},
  };

  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(
      async (params) => params.options[0]?.value as never,
    ) as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => [] as never) as unknown as WizardPrompter["multiselect"],
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => noopProgress),
    ...overrides,
  };
}
