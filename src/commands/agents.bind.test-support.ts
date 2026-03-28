import { vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

export const readConfigFileSnapshotMock = vi.fn();
export const writeConfigFileMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../config/config.js", async (importOriginal) => {
  return await mergeMockedModule(
    await importOriginal<typeof import("../config/config.js")>(),
    () => ({
      readConfigFileSnapshot: readConfigFileSnapshotMock,
      writeConfigFile: writeConfigFileMock,
    }),
  );
});

export const runtime = createTestRuntime();

export async function loadFreshAgentsCommandModuleForTest() {
  vi.resetModules();
  return await import("./agents.js");
}

export function resetAgentsBindTestHarness(): void {
  readConfigFileSnapshotMock.mockClear();
  writeConfigFileMock.mockClear();
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
}
