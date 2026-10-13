import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandEnv } from "../process/exec.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { loadDotEnv } from "./dotenv.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const BLOCKED_HOMEBREW_CONTROL_KEYS = [
  "HOMEBREW_API_DOMAIN",
  "HOMEBREW_ARTIFACT_DOMAIN",
  "HOMEBREW_BOTTLE_DOMAIN",
  "HOMEBREW_BREW_FILE",
  "HOMEBREW_BREW_GIT_REMOTE",
  "HOMEBREW_CORE_GIT_REMOTE",
  "HOMEBREW_CURL_PATH",
  "HOMEBREW_CURLRC",
  "HOMEBREW_GIT_PATH",
  "HOMEBREW_PREFIX",
  "HOMEBREW_SSH_CONFIG_PATH",
  "HOMEBREW_XDG_CONFIG_HOME",
] as const;
const ALLOWED_HOMEBREW_SETTINGS = {
  HOMEBREW_AUTO_UPDATE_SECS: "86400",
  HOMEBREW_NO_ANALYTICS: "1",
  HOMEBREW_NO_INSTALL_FROM_API: "1",
} as const;

describe("workspace .env Homebrew controls", () => {
  it("blocks dangerous controls while preserving benign Homebrew preferences", async () => {
    const envSnapshot = captureFullEnv();
    try {
      const rootDir = tempDirs.make("openclaw-dotenv-homebrew-");
      const workspaceDir = path.join(rootDir, "workspace");
      const stateDir = path.join(rootDir, "state");
      const shellKey = "HOMEBREW_API_DOMAIN";
      const globalKey = "HOMEBREW_BOTTLE_DOMAIN";

      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, ".env"),
        [
          ...BLOCKED_HOMEBREW_CONTROL_KEYS.map((key) => `${key}=workspace-${key}`),
          ...Object.entries(ALLOWED_HOMEBREW_SETTINGS).map(([key, value]) => `${key}=${value}`),
          "WORKSPACE_BUILD_LABEL=allowed",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(stateDir, ".env"),
        `${globalKey}=https://trusted.example/bottles\n`,
        "utf8",
      );

      for (const key of [
        ...BLOCKED_HOMEBREW_CONTROL_KEYS,
        ...Object.keys(ALLOWED_HOMEBREW_SETTINGS),
        "WORKSPACE_BUILD_LABEL",
      ]) {
        deleteTestEnvValue(key);
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue(shellKey, "https://shell.example/api");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      loadDotEnv({ quiet: true });
      const childEnv = resolveCommandEnv({ argv: ["brew", "install", "uv"] });

      expect(childEnv[shellKey]).toBe("https://shell.example/api");
      expect(childEnv[globalKey]).toBe("https://trusted.example/bottles");
      for (const key of BLOCKED_HOMEBREW_CONTROL_KEYS) {
        if (key !== shellKey && key !== globalKey) {
          expect(childEnv[key], `${key} should not reach brew from workspace .env`).toBeUndefined();
        }
      }
      for (const [key, value] of Object.entries(ALLOWED_HOMEBREW_SETTINGS)) {
        expect(childEnv[key]).toBe(value);
      }
      expect(childEnv.WORKSPACE_BUILD_LABEL).toBe("allowed");
    } finally {
      vi.restoreAllMocks();
      envSnapshot.restore();
    }
  });
});
