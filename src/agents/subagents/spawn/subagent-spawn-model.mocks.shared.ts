import { beforeEach, vi } from "vitest";
import { supportedSpawnModelChoice } from "./subagent-spawn.test-helpers.js";

beforeEach(async () => {
  const spawnRuntime = await import("./subagent-spawn.runtime.js");
  vi.spyOn(spawnRuntime, "prepareModelChoice").mockImplementation(supportedSpawnModelChoice);
});
