import { describe, expect, test } from "vitest";
import { validateConfigObject } from "./validation-core.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("Cloudflare Access OIDC GitHub identity config", () => {
  const trusted = {
    issuer: "https://example.cloudflareaccess.com",
    providerId: "verified-provider",
    githubAccountIdClaim: "https://openclaw.ai/github-account-id",
  };

  test.each([
    { name: "explicit mapping", mapping: trusted, success: true },
    {
      name: "non-Access issuer",
      mapping: { ...trusted, issuer: "https://example.test" },
      success: false,
    },
    {
      name: "HTTP issuer",
      mapping: { ...trusted, issuer: "http://example.cloudflareaccess.com" },
      success: false,
    },
    { name: "blank provider", mapping: { ...trusted, providerId: " " }, success: false },
    { name: "blank claim", mapping: { ...trusted, githubAccountIdClaim: " " }, success: false },
    { name: "incomplete mapping", mapping: { issuer: trusted.issuer }, success: false },
  ])("validates $name", ({ mapping, success }) => {
    expect(
      OpenClawSchema.safeParse({
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "cf-access-authenticated-user-email",
              cloudflareAccessOidc: mapping,
            },
          },
        },
      }).success,
    ).toBe(success);
  });
});

describe("gateway identity scope grants config", () => {
  test.each([
    { scope: "operator.admin", success: true },
    { scope: "operator.superuser", success: false },
  ])("validates configured scope $scope", ({ scope, success }) => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        auth: {
          identityScopes: {
            "admin@example.com": [scope],
          },
        },
      },
    });

    expect(result.success).toBe(success);
  });
});

describe("gateway operator role config", () => {
  const validRole = {
    sessions: { others: "view" },
    agents: ["guest-agent"],
    scopes: ["operator.read", "operator.write"],
  };
  const withRole = (role: unknown) => ({
    gateway: { roles: { default: "guest", definitions: { guest: role } } },
  });

  test("accepts GitHub login assignments to configured roles", () => {
    const roles = {
      default: "guest",
      definitions: { guest: validRole, release_admin: validRole },
      assignments: { byGithubLogin: { " Octo-Cat ": "release_admin" } },
    };

    expect(OpenClawSchema.parse({ gateway: { roles } }).gateway?.roles).toEqual(roles);
  });

  test.each([
    {
      name: "unknown assigned role",
      byGithubLogin: { octocat: "missing" },
      login: "octocat",
      message: "must name a configured role definition",
    },
    {
      name: "malformed GitHub login",
      byGithubLogin: { octo_cat: "guest" },
      login: "octo_cat",
      message: "Invalid GitHub login",
    },
    {
      name: "case-insensitive duplicate GitHub logins",
      byGithubLogin: { Octocat: "guest", octocat: "guest" },
      login: "octocat",
      message: "Duplicate GitHub login",
    },
  ])("rejects $name", ({ byGithubLogin, login, message }) => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        roles: {
          default: "guest",
          definitions: { guest: validRole },
          assignments: { byGithubLogin },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["gateway", "roles", "assignments", "byGithubLogin", login],
            message: expect.stringContaining(message),
          }),
        ]),
      );
    }
  });

  test("validates model source, scoped aliases, empty membership and future-family exclusions", () => {
    const result = validateConfigObject({
      agents: {
        entries: {
          shared: { model: "fixture/primary", models: { "fixture/fallback": { alias: "backup" } } },
        },
      },
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              ...validRole,
              modelPolicy: {
                sourceAgent: " SHARED ",
                allow: ["backup"],
                deny: ["fixture/restricted-*"],
              },
            },
            paused: { ...validRole, modelPolicy: { allow: [] } },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.gateway?.roles?.definitions.guest?.modelPolicy).toEqual({
        sourceAgent: "shared",
        allow: ["backup"],
        deny: ["fixture/restricted-*"],
      });
    }
  });

  test.each([
    { sourceAgent: "missing", deny: ["fixture/restricted-*"] },
    { sourceAgent: "shared", deny: ["unknown-alias"] },
    { sourceAgent: "shared", deny: ["fixture/*restricted"] },
    { sourceAgent: "shared", deny: ["*/restricted-*"] },
    { sourceAgent: "shared", deny: ["fixture/restricted-**"] },
    { sourceAgent: "shared", deny: ["fixture*"] },
    { sourceAgent: "shared", deny: ["fixture/restricted- *"] },
  ])("rejects model exclusions that cannot be applied as configured: %j", (modelPolicy) => {
    const result = validateConfigObject({
      agents: { entries: { shared: { model: "fixture/primary" } } },
      gateway: {
        roles: { default: "guest", definitions: { guest: { ...validRole, modelPolicy } } },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("gateway.roles.definitions.guest.modelPolicy"),
          }),
        ]),
      );
    }
  });

  test("accepts an access-policy plugin reference without plugin configuration", () => {
    const result = OpenClawSchema.parse(
      withRole({ ...validRole, accessPolicyPlugin: " unavailable-access-policy " }),
    );

    expect(result.gateway?.roles?.definitions.guest).toEqual({
      ...validRole,
      accessPolicyPlugin: "unavailable-access-policy",
    });
  });

  test.each([
    { name: "unknown session permission", role: { ...validRole, sessions: { others: "edit" } } },
    { name: "unknown sandbox policy", role: { ...validRole, sandbox: "optional" } },
    { name: "unknown operator scope", role: { ...validRole, scopes: ["operator.superuser"] } },
    { name: "resource wildcard expression", role: { ...validRole, agents: "agent:*" } },
    { name: "wildcard in an agent allowlist", role: { ...validRole, agents: ["*"] } },
    { name: "blank allowed agent", role: { ...validRole, agents: [" "] } },
    { name: "blank access-policy plugin", role: { ...validRole, accessPolicyPlugin: " " } },
    {
      name: "multiple access-policy plugins",
      role: { ...validRole, accessPolicyPlugin: ["first-policy", "second-policy"] },
    },
    {
      name: "overlong access-policy plugin",
      role: { ...validRole, accessPolicyPlugin: "a".repeat(129) },
    },
    { name: "missing session policy", role: { agents: "*", scopes: ["operator.read"] } },
    { name: "freeform capability", role: { ...validRole, capability: "sessions.delete" } },
  ])("rejects $name", ({ role }) => {
    const result = OpenClawSchema.safeParse(withRole(role));

    expect(result.success).toBe(false);
  });

  test("rejects a default role that has no definition", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        roles: { default: "missing", definitions: { guest: validRole } },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["gateway", "roles", "default"] }),
        ]),
      );
    }
  });

  test.each([
    {
      name: "role definitions without a default policy",
      roles: { definitions: { guest: validRole } },
      issuePath: ["gateway", "roles", "default"],
    },
    {
      name: "role enforcement without any definitions",
      roles: { definitions: {} },
      issuePath: ["gateway", "roles", "definitions"],
    },
  ])("rejects $name", ({ roles, issuePath }) => {
    const result = OpenClawSchema.safeParse({ gateway: { roles } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: issuePath })]),
      );
    }
  });

  test("normalizes and deduplicates configured agent and operator-scope allowlists", () => {
    const result = OpenClawSchema.safeParse(
      withRole({
        ...validRole,
        agents: [" Guest-Agent ", "guest-agent", "SECOND-agent"],
        scopes: ["operator.read", "operator.write", "operator.read"],
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gateway?.roles?.definitions.guest).toMatchObject({
        agents: ["guest-agent", "second-agent"],
        scopes: ["operator.read", "operator.write"],
      });
    }
  });
});
