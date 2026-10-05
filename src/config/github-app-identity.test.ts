import { describe, expect, it } from "vitest";
import {
  GitHubToolIdentitySchema,
  AgentGitHubToolIdentitySchema,
} from "./zod-schema.github-identity.js";
const identity = {
  profileId: "ghp_6128c113c0df8c1a366dfe690c062d8e",
  kind: "app-installation",
  app: {
    appId: 13361,
    installationId: 119386,
    accountId: 185961,
    repositories: [{ id: 1044511, fullName: "bic/lobster" }],
    permissions: { contents: "write", metadata: "read" },
    privateKey: { source: "env", provider: "default", id: "OPENCLAW_GITHUB_APP_PRIVATE_KEY" },
    keyVersion: "synthetic-version",
  },
};
describe("GitHub App config contract", () => {
  it("accepts the closed Factory generation and agent override without weakening PAT/OAuth shape", () => {
    expect(GitHubToolIdentitySchema.parse(identity)).toEqual(identity);
    expect(AgentGitHubToolIdentitySchema.parse({ ...identity, allowInSandbox: false })).toEqual({
      ...identity,
      allowInSandbox: false,
    });
    expect(GitHubToolIdentitySchema.safeParse({ ...identity, allowInSandbox: true }).success).toBe(
      false,
    );
    expect(
      GitHubToolIdentitySchema.safeParse({
        profileId: identity.profileId,
        kind: "oauth",
        app: identity.app,
      }).success,
    ).toBe(false);
  });
  it.each([
    { ...identity, app: undefined },
    { ...identity, app: { ...identity.app, installationId: 0 } },
    { ...identity, app: { ...identity.app, repositories: [] } },
    {
      ...identity,
      app: {
        ...identity.app,
        repositories: [...identity.app.repositories, ...identity.app.repositories],
      },
    },
    {
      ...identity,
      app: {
        ...identity.app,
        privateKey: { source: "env", provider: "default", id: "invalid-key" },
      },
    },
  ])("rejects incomplete or invalid App selection", (value) => {
    expect(GitHubToolIdentitySchema.safeParse(value).success).toBe(false);
  });
});
