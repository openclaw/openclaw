import { vi } from "vitest";

vi.mock("./subagent-spawn-deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-spawn-deps.js")>();
  const { supportedSpawnModelChoice } = await import("./subagent-spawn.test-helpers.js");
  return {
    ...actual,
    getSubagentSpawnDeps: () => ({
      ...actual.getSubagentSpawnDeps(),
      prepareModelChoice: supportedSpawnModelChoice,
    }),
  };
});
