// Focused public test helpers for Node builtin module mocks.

export {
  mockNodeBuiltinModule,
  mockNodeChildProcessExecFile,
  mockNodeChildProcessSpawnSync,
} from "./test-helpers/node-builtin-mocks.js";
export {
  withMockedPlatform,
  withMockedWindowsPlatform,
  withRestoredMocks,
  type RestorableMock,
} from "../test-utils/vitest-spies.js";
