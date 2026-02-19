import { vi } from "vitest";

export const configMocks = {
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
};

export const offsetMocks = {
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
