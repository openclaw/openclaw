import { expect } from "vitest";

export function expectText(output: string, included: string[], excluded: string[] = []) {
  for (const value of included) {
    expect(output).toContain(value);
  }
  for (const value of excluded) {
    expect(output).not.toContain(value);
  }
}
