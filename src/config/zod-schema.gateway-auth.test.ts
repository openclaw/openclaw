import { expect, it, test } from "vitest";
import { validateConfigObject, validateConfigObjectRaw } from "./validation-core.js";
import { ModelsConfigSchema } from "./zod-schema.core.js";
import { OpenClawSchema } from "./zod-schema.js";
import { SessionSchema } from "./zod-schema.session.js";

const accepts = (raw: unknown) => OpenClawSchema.safeParse(raw).success;

function expectSchemaIssue(raw: unknown, path: string[], message?: string) {
  const result = OpenClawSchema.safeParse(raw);
  expect(result.success).toBe(false);
  expect(result.error?.issues).toContainEqual(
    expect.objectContaining({
      path,
      ...(message ? { message: expect.stringContaining(message) } : {}),
    }),
  );
}

function validated(raw: unknown) {
  const result = validateConfigObject(raw);
  if (!result.ok) {
    throw new Error("Expected valid config");
  }
  return result.config;
}

const trusted = {
  issuer: "https://example.cloudflareaccess.com",
  providerId: "verified-provider",
  githubAccountIdClaim: "https://openclaw.ai/github-account-id",
};

test.each([
  ["non-Access issuer", { ...trusted, issuer: "https://example.test" }],
  ["HTTP issuer", { ...trusted, issuer: "http://example.cloudflareaccess.com" }],
  ["blank provider", { ...trusted, providerId: " " }],
  ["blank claim", { ...trusted, githubAccountIdClaim: " " }],
  ["incomplete mapping", { issuer: trusted.issuer }],
])("rejects %s", (_name, mapping) => {
  const auth = {
    mode: "trusted-proxy",
    trustedProxy: {
      userHeader: "cf-access-authenticated-user-email",
      cloudflareAccessOidc: mapping,
    },
  };
  expect(accepts({ gateway: { auth } })).toBe(false);
});

const validRole = {
  sessions: { others: "view" },
  agents: ["guest-agent"],
  scopes: ["operator.read", "operator.write"],
};
const withRole = (role: unknown) => ({
  gateway: { roles: { default: "guest", definitions: { guest: role } } },
});
const rolesConfig = (overrides: Record<string, unknown>) => ({
  gateway: { roles: { default: "guest", definitions: { guest: validRole }, ...overrides } },
});
const modelConfig = (modelPolicy: unknown, extraRoles = {}) => ({
  agents: {
    entries: {
      shared: { model: "fixture/primary", models: { "fixture/fallback": { alias: "backup" } } },
    },
  },
  ...rolesConfig({ definitions: { guest: { ...validRole, modelPolicy }, ...extraRoles } }),
});

test.each([
  [{ octocat: "missing" }, "octocat", "must name a configured role definition"],
  [{ octo_cat: "guest" }, "octo_cat", "Invalid GitHub login"],
  [{ Octocat: "guest", octocat: "guest" }, "octocat", "Duplicate GitHub login"],
] as const)("rejects GitHub assignment %j", (byGithubLogin, login, message) => {
  expectSchemaIssue(
    rolesConfig({ assignments: { byGithubLogin } }),
    ["gateway", "roles", "assignments", "byGithubLogin", login],
    message,
  );
});

test("validates model source, scoped aliases, empty membership and future-family exclusions", () => {
  const config = validated(
    modelConfig(
      { sourceAgent: " SHARED ", allow: ["backup"], deny: ["fixture/restricted-*"] },
      { paused: { ...validRole, modelPolicy: { allow: [] } } },
    ),
  );
  expect(config.gateway?.roles?.definitions.guest?.modelPolicy).toEqual({
    sourceAgent: "shared",
    allow: ["backup"],
    deny: ["fixture/restricted-*"],
  });
});

test.each([
  { sourceAgent: "missing", deny: ["fixture/restricted-*"] },
  { sourceAgent: "shared", deny: ["fixture/restricted-**"] },
  { sourceAgent: "shared", deny: ["fixture/restricted- *"] },
])("rejects model exclusions that cannot be applied as configured: %j", (modelPolicy) => {
  const result = validateConfigObject(modelConfig(modelPolicy));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining("gateway.roles.definitions.guest.modelPolicy"),
      }),
    );
  }
});

test.each([
  ["unknown session permission", { sessions: { others: "edit" } }],
  ["unknown sandbox policy", { sandbox: "optional" }],
  ["unknown operator scope", { scopes: ["operator.superuser"] }],
  ["wildcard in an agent allowlist", { agents: ["*"] }],
  ["blank access-policy plugin", { accessPolicyPlugin: " " }],
  ["missing session policy", { sessions: undefined, agents: "*", scopes: ["operator.read"] }],
  ["freeform capability", { capability: "sessions.delete" }],
] as const)("rejects %s", (_name, overrides) => {
  expect(accepts(withRole({ ...validRole, ...overrides }))).toBe(false);
});

test("rejects a default role that has no definition", () => {
  expectSchemaIssue(rolesConfig({ default: "missing" }), ["gateway", "roles", "default"]);
});

test.each([
  [{ definitions: { guest: validRole } }, "default"],
  [{ definitions: {} }, "definitions"],
] as const)("requires a role %s", (roles, field) => {
  expectSchemaIssue({ gateway: { roles } }, ["gateway", "roles", field]);
});

test("accepts a matching GitHub cloud endpoint", () => {
  const github = { host: "tenant.ghe.com", apiBaseUrl: "https://api.tenant.ghe.com" };
  expect(accepts({ gateway: { github } })).toBe(true);
});

test.each([
  { host: "ghe.example.test", apiBaseUrl: "https://api.other.example.test" },
  { host: "ghe.example.test", apiBaseUrl: "http://ghe.example.test/api/v3" },
  { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/other" },
  { host: "ghe.example.test" },
])("rejects a GitHub endpoint that could send credentials away from $host", (github) => {
  expect(accepts({ gateway: { github } })).toBe(false);
});

test("accepts a provider neutral repository default", () => {
  expect(
    accepts({
      gateway: {
        projects: {
          defaultRepository: { url: "https://ghe.example.test/acme/private-repo.git", ref: "main" },
        },
      },
      cloudWorkers: {
        projectProfiles: { "ghe.example.test/acme/private-repo": "example-worker" },
      },
    }),
  ).toBe(true);
});

it("preserves a SecretRef-only bundled overlay without custom provider fields", () => {
  const apiKey = { source: "file", provider: "x", id: "/runway" };
  const parsed = ModelsConfigSchema.parse({ providers: { runway: { apiKey } } });
  expect(parsed?.providers?.runway?.apiKey).toEqual(apiKey);
});

it("requires the legacy bailian-token-plan owner to remain an exact custom provider", () => {
  const acceptsProvider = (provider: unknown) =>
    ModelsConfigSchema.safeParse({
      providers: { "bailian-token-plan": provider },
    }).success;
  expect(acceptsProvider({ timeoutSeconds: 600 })).toBe(false);
  expect(
    acceptsProvider({
      api: "anthropic-messages",
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      models: [{ id: "qwen3.7-plus", name: "qwen3.7-plus" }],
    }),
  ).toBe(true);
});

it.each([
  ["preserveRecent", "forever"],
  ["resetArchiveRetention", "0d"],
  ["maxDiskBytes", "big"],
])("reports invalid %s maintenance values", (key, value) => {
  const result = SessionSchema.safeParse({ maintenance: { [key]: value } });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toContain(key);
});

it("rejects inherited realtime provider keys", () => {
  const realtime = { provider: "constructor", providers: { elevenlabs: { voiceId: "voice-123" } } };
  const result = OpenClawSchema.safeParse({ talk: { realtime } });
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

it("rejects a blank certPath", () => {
  const result = validateConfigObject({ gateway: { tls: { enabled: true, certPath: "" } } });
  expect(result.ok ? undefined : result.issues[0]?.path).toContain("certPath");
});

it("preserves exact non-empty cert and key path bytes", () => {
  const tls = {
    enabled: true,
    certPath: "  /etc/ssl/cert.pem  ",
    keyPath: "  /etc/ssl/private/server.key  ",
  };
  expect(validated({ gateway: { tls } }).gateway?.tls).toEqual(tls);
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
  expect(accepts({ worktreeRoot: "worktrees" })).toBe(false);
});
