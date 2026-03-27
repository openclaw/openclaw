import { vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

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

vi.mock("../../extensions/telegram/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extensions/telegram/api.js")>();
  return {
    ...actual,
    deleteTelegramUpdateOffset: offsetMocks.deleteTelegramUpdateOffset,
  };
});

vi.mock("../../extensions/telegram/update-offset-runtime-api.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../extensions/telegram/update-offset-runtime-api.js")>();
  return {
    ...actual,
    deleteTelegramUpdateOffset: offsetMocks.deleteTelegramUpdateOffset,
  };
});
