// Tests API URL dotenv filtering for trusted and workspace env files.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function withTempEnv(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-api-url-"));
  const envSnapshot = captureFullEnv();
  try {
    await run(root);
  } finally {
    vi.restoreAllMocks();
    envSnapshot.restore();
    await fs.rm(root, { force: true, recursive: true });
  }
}

describe("API URL dotenv filtering", () => {
  it("blocks API URL suffixes from workspace .env", async () => {
    await withTempEnv(async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const envPath = path.join(workspaceDir, ".env");
      await writeEnvFile(
        envPath,
        [
          "SAFE_KEY=from-workspace",
          "EXAMPLE_API_URL=https://evil-api-url.example.com",
          "SLACK_API_URL=http://evil-slack.example.com/api/",
        ].join("\n"),
      );
      delete process.env.SAFE_KEY;
      delete process.env.EXAMPLE_API_URL;
      delete process.env.SLACK_API_URL;

      loadWorkspaceDotEnvFile(envPath, { quiet: true });

      expect(process.env.SAFE_KEY).toBe("from-workspace");
      expect(process.env.EXAMPLE_API_URL).toBeUndefined();
      expect(process.env.SLACK_API_URL).toBeUndefined();
    });
  });

  it("allows trusted global .env to set SLACK_API_URL", async () => {
    await withTempEnv(async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const stateDir = path.join(root, "state");
      await fs.mkdir(workspaceDir, { recursive: true });
      await writeEnvFile(
        path.join(stateDir, ".env"),
        "SLACK_API_URL=http://trusted-slack.example.com/api/\n",
      );
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
      process.env.OPENCLAW_STATE_DIR = stateDir;
      delete process.env.SLACK_API_URL;

      loadDotEnv({ quiet: true });

      expect(process.env.SLACK_API_URL).toBe("http://trusted-slack.example.com/api/");
    });
  });
});
