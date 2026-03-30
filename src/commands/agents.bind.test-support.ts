import { vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

type ReplaceConfigFileResult = Awaited<
  ReturnType<(typeof import("../config/config.js"))["replaceConfigFile"]>
>;

export const readConfigFileSnapshotMock = vi.fn();
export const writeConfigFileMock = vi.fn().mockResolvedValue(undefined);
export const replaceConfigFileMock = vi.fn(
  async (params: { nextConfig: OpenClawConfig }): Promise<ReplaceConfigFileResult> => {
    await writeConfigFileMock(params.nextConfig);
    return {
      path: "/tmp/openclaw.json",
      previousHash: null,
      snapshot: {} as never,
      nextConfig: params.nextConfig,
    };
  },
);

vi.mock("../config/config.js", async (importOriginal) => {
  return await mergeMockedModule(
    await importOriginal<typeof import("../config/config.js")>(),
    () => ({
      readConfigFileSnapshot: readConfigFileSnapshotMock,
      writeConfigFile: writeConfigFileMock,
      replaceConfigFile: replaceConfigFileMock,
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
  replaceConfigFileMock.mockClear();
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
}
