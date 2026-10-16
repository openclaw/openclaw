import { vi } from "vitest";

type GenericMockProcedure = (...args: never[]) => unknown;

// Vitest's Mock<T> erases generic and overload relationships. Keep that conversion in one
// test-only boundary while ordinary runtime methods continue to use exact vi.fn<T> checking.
export function createGenericMock<T extends GenericMockProcedure>(
  implementation?: T | GenericMockProcedure,
): T {
  return (implementation ? vi.fn(implementation) : vi.fn()) as ReturnType<typeof vi.fn> & T;
}
