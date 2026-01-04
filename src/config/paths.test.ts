import { describe, expect, it } from "vitest";

import { resolveOAuthDir, resolveOAuthPath } from "./paths.js";

describe("oauth paths", () => {
  it("prefers CLAWDBOT_OAUTH_DIR over CLAWDBOT_STATE_DIR", () => {
    const env = {
      CLAWDBOT_OAUTH_DIR: "/custom/oauth",
      CLAWDBOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe("/custom/oauth");
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      "/custom/oauth/oauth.json",
    );
  });

  it("derives oauth path from CLAWDBOT_STATE_DIR when unset", () => {
    const env = {
      CLAWDBOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(
      "/custom/state/credentials",
    );
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      "/custom/state/credentials/oauth.json",
    );
  });
});
