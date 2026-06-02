import { vi } from "vitest";
import { mockNodeBuiltinModule } from "../../plugin-sdk/test-helpers/node-builtin-mocks.js";

/** Mock selected node:child_process exports while preserving unmentioned real exports. */
export async function mockNodeChildProcessModule(
  overrides: Partial<typeof import("node:child_process")>,
) {
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    overrides,
  );
}
