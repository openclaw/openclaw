import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

// mock-isolation: Ordinary inventory must not load the optional post-activation discovery graph.
vi.mock("./update-candidate-state.retained.js", () => {
  throw new Error("Ordinary inventory loaded post-activation deletion discovery");
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("reads an empty schema inventory without loading retained-store discovery", async () => {
  const stateDir = dirs.make("update-inventory-imports-");
  const { readUpdateStateSchemaVersionsInProcess } = await import("./update-candidate-state.js");
  await expect(
    readUpdateStateSchemaVersionsInProcess({
      stateDir,
      config: {},
      env: { OPENCLAW_STATE_DIR: stateDir },
    }),
  ).resolves.toEqual([
    {
      path: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      userVersion: null,
    },
    { path: path.join(stateDir, "control", "services.sqlite"), userVersion: null },
    { path: path.join(stateDir, "state", "openclaw.sqlite"), userVersion: null },
  ]);
});
