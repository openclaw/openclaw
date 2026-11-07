import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import { setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
} from "../test-support/home-env.test-support.js";

export function writeSkillFixture(
  dir: string,
  name = path.basename(dir),
  description = name,
  options: Omit<Parameters<typeof writeSkill>[0], "dir" | "name" | "description"> = {},
) {
  return writeSkill({ dir, name, description, ...options });
}

/** One suite-owned root, with optional home isolation and deterministic case directories. */
export function useLoadingFixture(prefix: string, isolateHome: boolean | "state" = false) {
  let root = "";
  let index = 0;
  let homeSnapshot: ReturnType<typeof setMockSkillsHomeEnv> | undefined;
  let tempHome: TempHomeEnv | undefined;
  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
    if (isolateHome) {
      if (isolateHome === "state") {
        tempHome = await createTempHomeEnv(`${prefix}home-`);
      } else {
        await fs.mkdir(path.join(root, "home"));
      }
      homeSnapshot = setMockSkillsHomeEnv(tempHome?.home ?? path.join(root, "home"));
    }
  });
  afterAll(async () => {
    const cleanup = async () => {
      await tempHome?.restore();
      await fs.rm(root, { recursive: true, force: true });
    };
    if (homeSnapshot) {
      await restoreMockSkillsHomeEnv(homeSnapshot, cleanup);
    } else {
      await cleanup();
    }
  });
  return {
    get root() {
      return root;
    },
    get home() {
      return tempHome?.home ?? path.join(root, "home");
    },
    async createDir(label = "workspace") {
      const dir = path.join(root, `${label}-${++index}`);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
  };
}

export function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return warn;
}
