import { describe, expect, it, test } from "vitest";
import { validateConfigObject, validateConfigObjectRaw } from "./validation-core.js";
import { ModelsConfigSchema } from "./zod-schema.core.js";
import { OpenClawSchema } from "./zod-schema.js";
import { SessionSchema } from "./zod-schema.session.js";

describe("Cloudflare Access OIDC GitHub identity config", () => {
  const trusted = {
    issuer: "https://example.cloudflareaccess.com",
    providerId: "verified-provider",
    githubAccountIdClaim: "https://openclaw.ai/github-account-id",
  };

  test.each([
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

describe("gateway operator role config", () => {
  const validRole = {
    sessions: { others: "view" },
    agents: ["guest-agent"],
    scopes: ["operator.read", "operator.write"],
  };
  const withRole = (role: unknown) => ({
    gateway: { roles: { default: "guest", definitions: { guest: role } } },
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
    { sourceAgent: "shared", deny: ["fixture/restricted-**"] },
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

  test.each([
    { name: "unknown session permission", role: { ...validRole, sessions: { others: "edit" } } },
    { name: "unknown sandbox policy", role: { ...validRole, sandbox: "optional" } },
    { name: "unknown operator scope", role: { ...validRole, scopes: ["operator.superuser"] } },
    { name: "wildcard in an agent allowlist", role: { ...validRole, agents: ["*"] } },
    { name: "blank access-policy plugin", role: { ...validRole, accessPolicyPlugin: " " } },
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
});

test("accepts a matching GitHub cloud endpoint", () => {
  const github = { host: "tenant.ghe.com", apiBaseUrl: "https://api.tenant.ghe.com" };
  expect(OpenClawSchema.safeParse({ gateway: { github } }).success).toBe(true);
});

test.each([
  { host: "ghe.example.test", apiBaseUrl: "https://api.other.example.test" },
  { host: "ghe.example.test", apiBaseUrl: "http://ghe.example.test/api/v3" },
  { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/other" },
  { host: "ghe.example.test" },
])("rejects a GitHub endpoint that could send credentials away from $host", (github) => {
  expect(OpenClawSchema.safeParse({ gateway: { github } }).success).toBe(false);
});

test("accepts a provider neutral repository default", () => {
  expect(
    OpenClawSchema.safeParse({
      gateway: {
        projects: {
          defaultRepository: { url: "https://ghe.example.test/acme/private-repo.git", ref: "main" },
        },
      },
      cloudWorkers: {
        projectProfiles: { "ghe.example.test/acme/private-repo": "example-worker" },
      },
    }).success,
  ).toBe(true);
});

describe("ModelsConfigSchema", () => {
  it("preserves a SecretRef-only bundled overlay without custom provider fields", () => {
    const apiKey = { source: "file", provider: "x", id: "/runway" };
    const parsed = ModelsConfigSchema.parse({ providers: { runway: { apiKey } } });
    expect(parsed?.providers?.runway?.apiKey).toEqual(apiKey);
  });

  it("requires the legacy bailian-token-plan owner to remain an exact custom provider", () => {
    expect(
      ModelsConfigSchema.safeParse({
        providers: { "bailian-token-plan": { timeoutSeconds: 600 } },
      }).success,
    ).toBe(false);
    expect(
      ModelsConfigSchema.safeParse({
        providers: {
          "bailian-token-plan": {
            api: "anthropic-messages",
            baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
            models: [{ id: "qwen3.7-plus", name: "qwen3.7-plus" }],
          },
        },
      }).success,
    ).toBe(true);
  });
});

describe("SessionSchema maintenance extensions", () => {
  it.each([
    ["preserveRecent", "forever"],
    ["resetArchiveRetention", "0d"],
    ["maxDiskBytes", "big"],
  ])("reports invalid %s maintenance values", (key, value) => {
    const result = SessionSchema.safeParse({ maintenance: { [key]: value } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toContain(key);
  });
});

describe("OpenClawSchema Talk provider selection", () => {
  it("rejects inherited realtime provider keys", () => {
    const selection = {
      provider: "constructor",
      providers: { elevenlabs: { voiceId: "voice-123" } },
    };
    const talk = { realtime: selection };
    const result = OpenClawSchema.safeParse({ talk });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["talk", "realtime", "provider"]);
  });

  it("requires an explicit selection when multiple providers are configured", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          providers: { acme: { voiceId: "voice-acme" }, elevenlabs: { voiceId: "voice-eleven" } },
        },
      }),
    ).toThrow(/talk\.provider|required/i);
  });
});

describe("gateway.tls schema", () => {
  it("rejects a blank certPath", () => {
    const result = validateConfigObject({ gateway: { tls: { enabled: true, certPath: "" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toContain("certPath");
    }
  });

  it("preserves exact non-empty cert and key path bytes", () => {
    const tls = {
      enabled: true,
      certPath: "  /etc/ssl/cert.pem  ",
      keyPath: "  /etc/ssl/private/server.key  ",
    };
    const result = validateConfigObject({ gateway: { tls } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.gateway?.tls).toEqual(tls);
    }
  });
});

it.each([
  [{ visibleReplies: true }, { visibleReplies: "automatic" }],
  [{ groupChat: { visibleReplies: false } }, { groupChat: { visibleReplies: "message_tool" } }],
])("normalizes boolean visible replies %#", (messages, expected) => {
  expect(validateConfigObjectRaw({ messages })).toMatchObject({
    ok: true,
    config: { messages: expected },
  });
});

it.each([
  [{ visibleReplies: "visible" }, "messages.visibleReplies"],
  [{ groupChat: { unmentionedInbound: true } }, "messages.groupChat.unmentionedInbound"],
])("rejects unsupported messages %j at %s", (messages, path) => {
  expect(validateConfigObjectRaw({ messages })).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([expect.objectContaining({ path })]),
  });
});

it("rejects a relative worktreeRoot", () => {
  expect(OpenClawSchema.safeParse({ worktreeRoot: "worktrees" }).success).toBe(false);
});
