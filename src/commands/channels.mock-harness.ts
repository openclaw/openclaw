import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

function buildBundledPluginModuleId(pluginId: string, artifactBasename: string): string {
  return ["..", "..", "extensions", pluginId, artifactBasename].join("/");
}

export const configMocks: {
  readConfigFileSnapshot: MockFn;
  writeConfigFile: MockFn;
} = {
  readConfigFileSnapshot: vi.fn() as unknown as MockFn,
  writeConfigFile: vi.fn().mockResolvedValue(undefined) as unknown as MockFn,
};

export const offsetMocks: {
  deleteTelegramUpdateOffset: MockFn;
} = {
  deleteTelegramUpdateOffset: vi.fn().mockResolvedValue(undefined) as unknown as MockFn,
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

vi.mock(
  buildBundledPluginModuleId("telegram", "update-offset-runtime-api.js"),
  async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      deleteTelegramUpdateOffset: offsetMocks.deleteTelegramUpdateOffset,
    };
  },
);
