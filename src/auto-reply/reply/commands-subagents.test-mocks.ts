import { vi } from "vitest";

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

export function installSubagentsCommandCoreMocks() {}
