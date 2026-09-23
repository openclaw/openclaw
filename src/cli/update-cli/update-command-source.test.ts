import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { UPDATE_DEV_TARGET_REF_ENV } from "../../infra/update-dev-target.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as shared from "./shared.js";
import { prepareUpdateCommand } from "./update-command-run.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["stable", "beta", "extended-stable"])(
  "keeps Doctor's source update on dev while preserving saved %s policy",
  async (channel) => {
    const home = dirs.make("doctor-source-target-");
    const root = path.join(home, "source");
    const configPath = path.join(home, "openclaw.json");
    fs.mkdirSync(root);
    execFileSync("git", ["init", "--quiet", root]);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.4"}');
    const config = JSON.stringify({ update: { channel } });
    fs.writeFileSync(configPath, config);
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
    vi.stubEnv(UPDATE_DEV_TARGET_REF_ENV, "invalid\nref");
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(path.join(home, "other-install"));
    const opts = { sourceUpdate: { root }, timeout: "1200", dryRun: true };
    const prepared = await prepareUpdateCommand(opts);
    expect(prepared).toMatchObject({
      discoveredRoot: root,
      installKind: "git",
      requestedChannel: null,
    });
    const target = await resolveUpdateCommandTarget(
      opts,
      { triageTarget: { env: process.env } },
      undefined,
      prepared,
      {
        enter: async () => {
          throw new Error("Source target selection must remain read-only");
        },
      },
      1200_000,
    );
    expect(target).toMatchObject({
      root,
      channel: "dev",
      storedChannel: channel,
      updateInstallKind: "git",
      switchToPackage: false,
      devTarget: undefined,
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(config);
    expect(fs.existsSync(path.join(home, "state"))).toBe(false);
  },
);
