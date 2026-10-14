import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as service from "../daemon/service.js";
import * as exec from "../process/exec.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { registerUpdateCli } from "./update-cli.js";
import * as shared from "./update-cli/shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  ["update", "--json"],
  ["update", "--json", "--dry-run", "--channel", "dev"],
  ["update", "repair", "--json"],
  ["update", "finalize", "--json"],
])(
  "refuses registered host-owned %j before subprocesses, services, or state admission",
  async (...args) => {
    const root = tempDirs.make("openclaw-host-update-cli-");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "state", "openclaw.json"));
    const installOwner = {
      schemaVersion: 1,
      owner: "macos-app",
      displayName: "OpenClaw.app",
      updateHint: "Update OpenClaw.app to update this Gateway.",
    };
    await fs.writeFile(
      path.join(root, "openclaw-install-owner.json"),
      JSON.stringify(installOwner),
    );
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
    const subprocess = vi
      .spyOn(exec, "runCommandWithTimeout")
      .mockRejectedValue(new Error("unexpected subprocess"));
    const gatewayService = vi.spyOn(service, "resolveGatewayService").mockImplementation(() => {
      throw new Error("unexpected service access");
    });
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const program = new Command();
    registerUpdateCli(program);

    await expect(program.parseAsync(args, { from: "user" })).rejects.toBeInstanceOf(ExitError);

    expect(json).toHaveBeenCalledExactlyOnceWith({
      status: "host-managed",
      reason: "host-owned-install",
      installKind: "host",
      installOwner,
      message: "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
      steps: [],
    });
    expect(subprocess).not.toHaveBeenCalled();
    expect(gatewayService).not.toHaveBeenCalled();
  },
);
