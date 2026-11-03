import { expect } from "vitest";

export function expectPartialCall(mock: unknown, shape: object) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(shape));
}

export function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}
