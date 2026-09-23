import { expect } from "vitest";

export function promptMessages(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => {
    const message = (call[0] as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  });
}
export function expectPromptMessageContaining(
  mock: { mock: { calls: unknown[][] } },
  expected: string,
) {
  expect(promptMessages(mock).join("\n")).toContain(expected);
}
export function expectPromptMessage(mock: { mock: { calls: unknown[][] } }, expected: string) {
  expect(promptMessages(mock)).toContain(expected);
}
