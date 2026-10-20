import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import {
  configuredOAuthIdentities,
  captureGitHubOAuthAuthorizationIdentity,
} from "./github-oauth-lifecycle-helpers.js";
import {
  identity,
  NEW_PROFILE,
  OLD_PROFILE,
  OTHER_PROFILE,
} from "./github-oauth-lifecycle.test-support.js";

describe("GitHub OAuth maintenance inventory", () => {
  it("bounds roster reads while preserving ordered identities and fresh configuration", () => {
    const count = 128;
    const entries: Record<string, { tools: { github?: GitHubToolIdentityConfig } }> = {};
    for (let index = count; index > 0; index -= 1) {
      entries[`agent-${String(index).padStart(3, "0")}`] = { tools: {} };
    }
    let reads = 0;
    const observed = new Proxy(entries, {
      get(target, key, receiver) {
        reads += typeof key === "string" && Object.hasOwn(target, key) ? 1 : 0;
        return Reflect.get(target, key, receiver);
      },
    });
    const config: OpenClawConfig = { agents: { entries: observed } };
    expect(configuredOAuthIdentities(config)).toEqual([]);
    // Idle maintenance should traverse a large roster a bounded number of times.
    expect(reads).toBeLessThanOrEqual(count * 4);

    const system = identity(OLD_PROFILE, { oauth: true, author: true });
    const agent = identity(NEW_PROFILE, { oauth: true, author: true });
    config.tools = { github: system };
    entries["agent-128"] = { tools: { github: agent } };
    entries["agent-064"] = { tools: { github: system } };
    entries["agent-001"] = { tools: { github: identity(OTHER_PROFILE) } };
    expect(configuredOAuthIdentities(config)).toEqual([
      { scope: "system", agentId: "system", identity: system },
      { scope: "agent", agentId: "agent-064", identity: system },
      { scope: "agent", agentId: "agent-128", identity: agent },
    ]);
    entries["agent-001"] = { tools: { github: agent } };
    delete entries["agent-128"];
    expect(configuredOAuthIdentities(config)).toEqual([
      { scope: "system", agentId: "system", identity: system },
      { scope: "agent", agentId: "agent-001", identity: agent },
      { scope: "agent", agentId: "agent-064", identity: system },
    ]);
  });
});

it("never captures a GitHub App signing key in OAuth device authorization state", () => {
  const config: OpenClawConfig = {
    tools: {
      github: {
        kind: "app-installation",
        profileId: OLD_PROFILE,
        app: {
          appId: 1,
          installationId: 2,
          accountId: 3,
          repositories: [{ id: 4, fullName: "example/project" }],
          permissions: { contents: "read" },
          privateKey: "synthetic-signing-key",
          keyVersion: "synthetic-v1",
        },
      },
    },
  };
  expect(() =>
    captureGitHubOAuthAuthorizationIdentity(config, { scope: "system", agentId: "main" }),
  ).toThrow("before connecting an OAuth identity");
  const oauth = identity(OLD_PROFILE, { oauth: true });
  config.tools = { github: oauth };
  const captured = captureGitHubOAuthAuthorizationIdentity(config, {
    scope: "system",
    agentId: "main",
  });
  expect(captured).toEqual(oauth);
  oauth.profileId = NEW_PROFILE;
  expect(captured?.profileId).toBe(OLD_PROFILE);
});
