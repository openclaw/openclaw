import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

function buildBundledPluginModuleId(pluginId: string, artifactBasename: string): string {
  return ["..", "..", "extensions", pluginId, artifactBasename].join("/");
}

const readConfigFileSnapshotMock = vi.fn() as unknown as MockFn;
const writeConfigFileMock = vi.fn().mockResolvedValue(undefined) as unknown as MockFn;
const replaceConfigFileMock = vi.fn(async (params: { nextConfig: unknown }) => {
  await writeConfigFileMock(params.nextConfig);
}) as unknown as MockFn;

export const configMocks: {
  readConfigFileSnapshot: MockFn;
  writeConfigFile: MockFn;
  replaceConfigFile: MockFn;
} = {
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
};

export const offsetMocks: {
  deleteTelegramUpdateOffset: MockFn;
} = {
  deleteTelegramUpdateOffset: vi.fn().mockResolvedValue(undefined) as unknown as MockFn,
};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
    replaceConfigFile: configMocks.replaceConfigFile,
  };
});

vi.mock(buildBundledPluginModuleId("telegram", "update-offset-runtime-api.js"), async () => {
  const actual: Record<string, unknown> = await vi.importActual(
    buildBundledPluginModuleId("telegram", "update-offset-runtime-api.js"),
  );
  return {
    ...actual,
    deleteTelegramUpdateOffset: offsetMocks.deleteTelegramUpdateOffset,
  };
});
