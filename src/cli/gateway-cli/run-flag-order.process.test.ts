import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatInvalidPortOption } from "../error-format.js";
import {
  INVALID_AUTH,
  INVALID_BIND,
  INVALID_TAILSCALE,
  INVALID_WS_LOG,
} from "./run-flag-checks.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

// Runs the full CLI (preaction + startup preflight) with no config file.
it.each([
  ["--port", "abc", formatInvalidPortOption("--port")],
  ["--bind", "bogus", INVALID_BIND],
  ["--auth", "bogus", INVALID_AUTH],
  ["--tailscale", "bogus", INVALID_TAILSCALE],
  ["--ws-log", "bogus", INVALID_WS_LOG],
])(
  "gateway run %s reports the flag error before missing config",
  (flag, value, message) => {
    const root = fs.realpathSync(tempDirs.make("openclaw-gateway-flag-order-"));
    const stateDir = path.join(root, "state");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", "gateway", "run", flag, value],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          NO_COLOR: "1",
        },
      },
    );
    expect(child.stderr + child.stdout).toContain(message);
    expect(child.stderr + child.stdout).not.toContain("Missing config");
    expect(child.status).toBe(1);
  },
  150_000,
);
