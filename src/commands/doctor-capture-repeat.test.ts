import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as packageRoot from "../infra/openclaw-root.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { doctorCommand } from "./doctor.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it("reuses one original across three healthy Doctor repairs and captures a real change", async () => {
  const root = await fs.realpath(dirs.make("doctor-capture-repeat-"));
  const state = path.join(root, "state");
  const temporary = path.join(root, "tmp");
  await fs.mkdir(state);
  await fs.mkdir(temporary);
  const config = path.join(state, "openclaw.json");
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
    OPENCLAW_UPDATE_IN_PROGRESS: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
  })) {
    vi.stubEnv(key, value);
  }
  expect(resolveManagedUpdateLeaseDatabasePath().startsWith(`${temporary}${path.sep}`)).toBe(true);
  // The install root is disposable too: Doctor may repair source-install artifacts.
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.10.22" }),
  );
  await fs.mkdir(path.join(root, "workspace"));
  await fs.writeFile(
    config,
    JSON.stringify({
      gateway: { mode: "local", port: 1, auth: { mode: "token", token: "synthetic-doctor-token" } },
      agents: { defaults: { workspace: path.join(root, "workspace") } },
      memory: { search: { enabled: false, rememberAcrossConversations: false } },
      plugins: { enabled: false },
    }),
  );
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const repair = async () => {
    await doctorCommand(runtime, { repair: true, nonInteractive: true, json: true });
    await closeOpenClawStateDatabaseAsync();
    expect(
      runtime.exit.mock.calls.every(([code]) => code === 0),
      runtime.log.mock.calls.flat().join("\n"),
    ).toBe(true);
  };
  // Finish first-install migrations (including the one-time ACP repair marker)
  // before measuring unchanged healthy runs. No repair/capture owner is mocked.
  await repair();
  await repair();
  const captureRoot = resolveUpdateCaptureRoot(state);
  await fs.rm(captureRoot, { recursive: true, force: true });
  const captures = async () =>
    (await fs.readdir(captureRoot)).filter((name) => name.startsWith("doctor-"));
  const databasePath = path.join(state, "state", "openclaw.sqlite");
  const healthyDatabase = await fs.readFile(databasePath);
  for (let run = 1; run <= 3; run++) {
    await repair();
    expect.soft(await captures(), `healthy repair ${run}`).toHaveLength(1);
    expect
      .soft(
        (await fs.readFile(databasePath)).equals(healthyDatabase),
        `healthy repair ${run} leaves SQLite unchanged`,
      )
      .toBe(true);
  }
  const before = await captures();
  const cfg = JSON.parse(await fs.readFile(config, "utf8"));
  cfg.gateway.port = 2;
  await fs.writeFile(config, JSON.stringify(cfg));
  await repair();
  expect(await captures()).toHaveLength(2);
  expect(await captures()).toEqual(expect.arrayContaining(before));
});
