import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  snapshotSourceFamily,
  writeUnreadableNewerStateSchema,
} from "../../state/openclaw-database-preflight.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import { updateStatusCommand } from "./status.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  checkUpdateStatus: async () => ({
    root: "/fixture/openclaw",
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.8" },
  }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => "/fixture/openclaw",
}));
vi.mock("../../commands/node-runtime-diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/node-runtime-diagnostics.js")>()),
  collectNodeRuntimeFindings: async () => [],
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let gatewayPort: TestPortClaim;
beforeAll(async () => {
  gatewayPort = await acquireTestPortBlock({ offsets: [0] });
});
afterAll(async () => {
  await gatewayPort?.release();
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "keeps newer-schema bytes, mtimes, and sidecars unchanged through the real Gateway probe (JSON: %s)",
  async (json) => {
    const stateDir = tempDirs.make("openclaw-update-status-readonly-");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local", auth: { mode: "none" }, port: gatewayPort.port },
        plugins: { enabled: false },
      }),
    );
    const databasePath = openOpenClawStateDatabase().path;
    await closeOpenClawStateDatabaseAsync();
    writeUnreadableNewerStateSchema(databasePath);
    const before = snapshotSourceFamily(databasePath);

    await updateStatusCommand({ json });

    const output = json
      ? JSON.stringify(runtime.writeJson.mock.lastCall?.[0])
      : runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("newer schema version");
    expect(output).toMatch(/build.*supports/);
    expect(output).toMatch(/restore.*backup/);
    expect(output).not.toContain("doctor --fix");
    expect(snapshotSourceFamily(databasePath)).toEqual(before);
  },
);
