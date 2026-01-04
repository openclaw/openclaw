import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { resolveOAuthPath } from "../config/paths.js";
import { writeOAuthCredentials } from "./onboard-auth.js";

describe("writeOAuthCredentials", () => {
  const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
  let tempStateDir: string | null = null;

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.CLAWDBOT_STATE_DIR;
    } else {
      process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    }
    delete process.env.CLAWDBOT_OAUTH_DIR;
  });

  it("writes oauth.json under CLAWDBOT_STATE_DIR/credentials", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-oauth-"));
    process.env.CLAWDBOT_STATE_DIR = tempStateDir;

    const creds = {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("anthropic", creds);

    const oauthPath = resolveOAuthPath();
    expect(oauthPath).toBe(
      path.join(tempStateDir, "credentials", "oauth.json"),
    );

    const raw = await fs.readFile(oauthPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, OAuthCredentials>;
    expect(parsed.anthropic).toMatchObject({
      refresh: "refresh-token",
      access: "access-token",
    });
  });
});
