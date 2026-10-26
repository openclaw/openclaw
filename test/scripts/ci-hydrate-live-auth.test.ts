import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/ci-hydrate-live-auth.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function hydrate(env: NodeJS.ProcessEnv) {
  const root = tempDirs.make("openclaw-live-auth-");
  const profile = join(root, "live.profile");
  const githubEnv = join(root, "github.env");
  const result = spawnSync("/bin/bash", [SCRIPT, profile], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      HOME: root,
      PATH: process.env.PATH,
      GITHUB_ENV: githubEnv,
      ...env,
    },
  });
  return {
    ...result,
    githubEnv: readFileSync(githubEnv, "utf8"),
    profile: readFileSync(profile, "utf8"),
  };
}

describe("CI live auth hydration", () => {
  it("uses the Claude setup token when credentials JSON cannot supply a fresh access token", () => {
    const oauthToken = "sk-ant-oat01-synthetic-setup-token";
    const result = hydrate({
      ANTHROPIC_API_KEY: "synthetic-api-key",
      CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
      OPENCLAW_CLAUDE_CREDENTIALS_JSON: JSON.stringify({
        claudeAiOauth: { accessToken: "expired-token", expiresAt: 0 },
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.profile).toContain(`export ANTHROPIC_OAUTH_TOKEN=${oauthToken}`);
    expect(result.githubEnv).toContain(`ANTHROPIC_OAUTH_TOKEN=${oauthToken}\n`);
    expect(result.stderr).not.toContain(oauthToken);
  });

  it("prefers a fresh credentials access token over the setup-token fallback", () => {
    const freshToken = "sk-ant-oat01-synthetic-fresh-token";
    const fallback = "sk-ant-oat01-synthetic-setup-token";
    const result = hydrate({
      CLAUDE_CODE_OAUTH_TOKEN: fallback,
      OPENCLAW_CLAUDE_CREDENTIALS_JSON: JSON.stringify({
        claudeAiOauth: {
          accessToken: freshToken,
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        },
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.profile).toContain(`export ANTHROPIC_OAUTH_TOKEN=${freshToken}`);
    expect(result.profile).not.toContain(`export ANTHROPIC_OAUTH_TOKEN=${fallback}`);
    expect(result.stderr).not.toMatch(/synthetic-(?:fresh|setup)-token/u);
  });
});
