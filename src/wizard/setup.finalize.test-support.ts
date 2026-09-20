/** Assertions for the wizard's user-facing notes. */
import { expect, vi } from "vitest";
import type { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";

export function expectNoteContains(
  prompter: ReturnType<typeof buildWizardPrompter>,
  expected: string,
  title: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[0].includes(expected) && call[1] === title)).not.toEqual([]);
}

export function expectNoteTitleNotCalled(
  prompter: ReturnType<typeof buildWizardPrompter>,
  title: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[1] === title)).toEqual([]);
}

export function expectNoteNotContains(
  prompter: ReturnType<typeof buildWizardPrompter>,
  unexpected: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[0].includes(unexpected))).toEqual([]);
}

export async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}
