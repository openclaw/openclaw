import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export const configMocks: {
  readConfigFileSnapshot: MockFn;
  writeConfigFile: MockFn;
} = {
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
};

export const offsetMocks: {
  deleteTelegramUpdateOffset: MockFn;
} = {
  deleteTelegramUpdateOffset: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

vi.mock("../telegram/update-offset-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram/update-offset-store.js")>();
  return {
    ...actual,
    deleteTelegramUpdateOffset: offsetMocks.deleteTelegramUpdateOffset,
  };
});
