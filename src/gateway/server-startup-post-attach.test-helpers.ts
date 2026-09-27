import { vi } from "vitest";

export function createHookCronHostFixture() {
  return {
    list: vi.fn(),
    getJob: vi.fn(),
    run: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    updateWithPrecondition: vi.fn(),
    remove: vi.fn(),
    removeStaleJobFamily: vi.fn(),
  };
}
