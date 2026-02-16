import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const noopAsync = async () => {};
export const noop = () => {};

export function createExitThrowingRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

export function createWizardPrompter(
  overrides: Partial<WizardPrompter>,
  options?: { defaultSelect?: string },
): WizardPrompter {
  return {
    intro: vi.fn(noopAsync),
    outro: vi.fn(noopAsync),
    note: vi.fn(noopAsync),
    select: vi.fn(async () => (options?.defaultSelect ?? "") as never),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as unknown as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: noop, stop: noop })),
    ...overrides,
  };
}
