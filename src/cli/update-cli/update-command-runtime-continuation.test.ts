import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as updateGlobal from "../../infra/update-global.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

it.each([undefined, "installed"] as const)(
  "keeps the selected runtime and live selectors during fresh-profile continuation (admission=%s)",
  async (admission) => {
    const home = path.dirname(fixture.root);
    const stateDir = path.join(home, ".openclaw-runtime");
    const oldRuntimeDir = path.join(home, ".nvm", "versions", "node", "v22.18.0", "bin");
    const admissionEnv = {
      ...process.env,
      OPENCLAW_PROFILE: "runtime",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "synthetic-runtime-continuation-token",
      NPM_CONFIG_USERCONFIG: path.join(home, "empty.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(home, "empty-global.npmrc"),
      PATH: oldRuntimeDir,
    };
    vi.spyOn(commandRun, "resolveUpdateCommandAdmissionEnv").mockResolvedValue(admissionEnv);
    vi.mocked(updateGlobal.createGlobalInstallEnv).mockRestore();
    const stopped = new Error("stop before package installation");
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockRejectedValue(stopped);

    await expect(
      updateCommand({ admission, yes: true, json: true, restart: false }),
    ).rejects.toThrow(stopped);

    expect(packageUpdate.stagePackageInstallUpdate).toHaveBeenCalledOnce();
    const [staged] = expectDefined(
      vi.mocked(packageUpdate.stagePackageInstallUpdate).mock.calls[0],
      "staged package parameters",
    );
    const liveSelectors = {
      OPENCLAW_PROFILE: admissionEnv.OPENCLAW_PROFILE,
      OPENCLAW_STATE_DIR: admissionEnv.OPENCLAW_STATE_DIR,
      OPENCLAW_CONFIG_PATH: admissionEnv.OPENCLAW_CONFIG_PATH,
    };
    expect(staged.managedServiceEnv).toMatchObject(liveSelectors);
    if (admission === "installed") {
      expect(staged.installEnv).toMatchObject(liveSelectors);
    } else {
      const privateState = expectDefined(
        staged.installEnv?.OPENCLAW_STATE_DIR,
        "private staging state",
      );
      expect(privateState).not.toBe(admissionEnv.OPENCLAW_STATE_DIR);
      expect(staged.installEnv?.OPENCLAW_CONFIG_PATH).toBe(
        path.join(privateState, "openclaw.json"),
      );
      expect(staged.installEnv?.OPENCLAW_PROFILE).toBeUndefined();
      expect(fs.existsSync(path.dirname(privateState))).toBe(false);
    }
    expect(staged.installEnv?.OPENCLAW_GATEWAY_TOKEN).toBe(admissionEnv.OPENCLAW_GATEWAY_TOKEN);
    expect(staged.installEnv?.PATH?.split(path.delimiter)).toEqual([
      path.dirname(process.execPath),
      oldRuntimeDir,
    ]);
    expect(staged.managedServiceEnv?.PATH).toBe(oldRuntimeDir);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(admissionEnv))).toBe(false);
  },
);
