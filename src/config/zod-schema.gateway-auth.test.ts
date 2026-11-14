import { expect, test } from "vitest";
import { validateConfigObject, validateConfigObjectRaw } from "./validation-core.js";
import { ModelsConfigSchema } from "./zod-schema.core.js";
import { OpenClawSchema } from "./zod-schema.js";
import { SessionSchema } from "./zod-schema.session.js";

const accepts = (raw: unknown) => OpenClawSchema.safeParse(raw).success;

function expectSchemaIssue(raw: unknown, path: string[], message?: string) {
  const result = OpenClawSchema.safeParse(raw);
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
  const trustedProxy = {
    userHeader: "cf-access-authenticated-user-email",
    cloudflareAccessOidc: mapping,
  };
  expect(accepts({ gateway: { auth: { mode: "trusted-proxy", trustedProxy } } })).toBe(false);
});

const validRole = {
  sessions: { others: "view" },
  agents: ["guest-agent"],
  scopes: ["operator.read", "operator.write"],
};
const rolesConfig = (overrides: Record<string, unknown>) => ({
  gateway: { roles: { default: "guest", definitions: { guest: validRole }, ...overrides } },
});
const modelConfig = (modelPolicy: unknown, extraRoles = {}) => ({
  agents: { entries: { shared: { models: { "fixture/fallback": { alias: "backup" } } } } },
  ...rolesConfig({ definitions: { guest: { ...validRole, modelPolicy }, ...extraRoles } }),
});

test("accepts a conversation-scoped automation role without operator.write", () => {
  const scopes = ["operator.sessions.write", "operator.cron"];
  const config = validated(rolesConfig({ definitions: { guest: { ...validRole, scopes } } }));
  expect(config.gateway?.roles?.definitions.guest?.scopes).toEqual(scopes);
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
  const modelPolicy = {
    sourceAgent: " SHARED ",
    allow: ["backup"],
    deny: ["fixture/restricted-*"],
  };
  const config = validated(
    modelConfig(modelPolicy, { paused: { ...validRole, modelPolicy: { allow: [] } } }),
  );
  expect(config.gateway?.roles?.definitions.guest?.modelPolicy).toEqual({
    ...modelPolicy,
    sourceAgent: "shared",
  });
});

test("accepts only explicit nonstandard Access grants independently of model policy", () => {
  const config = validated(
    rolesConfig({
      definitions: {
        guest: {
          ...validRole,
          accessPrograms: { cyber: ["daybreak_red", "daybreak_blue", "daybreak_red"] },
        },
      },
    }),
  );
  expect(config.gateway?.roles?.definitions.guest?.accessPrograms).toEqual({
    cyber: ["daybreak_red", "daybreak_blue"],
  });
});

test.each([
  { sourceAgent: "missing", deny: ["fixture/restricted-*"] },
  { sourceAgent: "shared", deny: ["fixture/restricted-**"] },
  { sourceAgent: "shared", deny: ["fixture/restricted- *"] },
])("rejects model exclusions that cannot be applied as configured: %j", (modelPolicy) => {
  expect(validateConfigObject(modelConfig(modelPolicy))).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringContaining("gateway.roles.definitions.guest.modelPolicy"),
      }),
    ]),
  });
});

test.each([
  ["unknown session permission", { sessions: { others: "edit" } }],
  ["unknown sandbox policy", { sandbox: "optional" }],
  ["wildcard Access grant", { accessPrograms: { cyber: ["*"] } }],
  ["implicit standard Access grant", { accessPrograms: { cyber: ["standard"] } }],
  ["unknown Access grant", { accessPrograms: { cyber: ["blue"] } }],
  ["unknown operator scope", { scopes: ["operator.superuser"] }],
  ["leading whitespace in an operator scope", { scopes: [" operator.read"] }],
  ["trailing whitespace in an operator scope", { scopes: ["operator.write "] }],
  ["blank operator scope", { scopes: [" \t"] }],
  ["wildcard in an agent allowlist", { agents: ["*"] }],
  ["blank access-policy plugin", { accessPolicyPlugin: " " }],
  ["missing session policy", { sessions: undefined, agents: "*", scopes: ["operator.read"] }],
  ["freeform capability", { capability: "sessions.delete" }],
] as const)("rejects %s", (_name, overrides) => {
  const definitions = { guest: { ...validRole, ...overrides } };
  expect(accepts(rolesConfig({ definitions }))).toBe(false);
});

test.each([
  [{ default: "missing", definitions: { guest: validRole } }, "default"],
  [{ definitions: { guest: validRole } }, "default"],
  [{ definitions: {} }, "definitions"],
] as const)("requires a role %s", (roles, field) => {
  expectSchemaIssue({ gateway: { roles } }, ["gateway", "roles", field]);
});

test.each([
  ["tenant.ghe.com", "https://api.tenant.ghe.com", true],
  ["ghe.example.test", "https://api.other.example.test", false],
  ["ghe.example.test", "http://ghe.example.test/api/v3", false],
  ["ghe.example.test", "https://ghe.example.test/other", false],
  ["ghe.example.test", undefined, false],
])("validates GitHub credential endpoint %s %s", (host, apiBaseUrl, expected) => {
  expect(accepts({ gateway: { github: { host, apiBaseUrl } } })).toBe(expected);
});

test("accepts a provider neutral repository default", () => {
  const defaultRepository = { url: "https://ghe.example.test/acme/private-repo.git", ref: "main" };
  const projectProfiles = { "ghe.example.test/acme/private-repo": "example-worker" };
  expect(
    accepts({
      gateway: { projects: { defaultRepository } },
      cloudWorkers: { projectProfiles },
    }),
  ).toBe(true);
});

test("preserves a SecretRef-only bundled overlay without custom provider fields", () => {
  const apiKey = { source: "file", provider: "x", id: "/runway" };
  const parsed = ModelsConfigSchema.parse({ providers: { runway: { apiKey } } });
  expect(parsed?.providers?.runway?.apiKey).toEqual(apiKey);
});

test.each([
  [{ timeoutSeconds: 600 }, false],
  [
    {
      api: "anthropic-messages",
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
      models: [{ id: "qwen3.7-plus", name: "qwen3.7-plus" }],
    },
    true,
  ],
])("requires bailian-token-plan to remain an exact custom provider: %j", (provider, expected) => {
  expect(
    ModelsConfigSchema.safeParse({ providers: { "bailian-token-plan": provider } }).success,
  ).toBe(expected);
});

test.each([
  ["preserveRecent", "forever"],
  ["resetArchiveRetention", "0d"],
  ["maxDiskBytes", "big"],
])("reports invalid %s maintenance values", (key, value) => {
  const result = SessionSchema.safeParse({ maintenance: { [key]: value } });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toContain(key);
});

test("rejects inherited realtime provider keys", () => {
  expectSchemaIssue(
    { talk: { realtime: { provider: "constructor", providers: { elevenlabs: {} } } } },
    ["talk", "realtime", "provider"],
  );
});

test("requires an explicit selection when multiple providers are configured", () => {
  const providers = { acme: { voiceId: "voice-acme" }, elevenlabs: { voiceId: "voice-eleven" } };
  expect(() => OpenClawSchema.parse({ talk: { providers } })).toThrow(/talk\.provider|required/i);
});

test("rejects a blank certPath", () => {
  const result = validateConfigObject({ gateway: { tls: { enabled: true, certPath: "" } } });
  expect(result.ok ? undefined : result.issues[0]?.path).toContain("certPath");
});

test("preserves exact non-empty cert and key path bytes", () => {
  const tls = {
    enabled: true,
    certPath: "  /etc/ssl/cert.pem  ",
    keyPath: "  /etc/ssl/private/server.key  ",
  };
  expect(validated({ gateway: { tls } }).gateway?.tls).toEqual(tls);
});

test.each([
  [{ visibleReplies: true }, { visibleReplies: "automatic" }],
  [{ groupChat: { visibleReplies: false } }, { groupChat: { visibleReplies: "message_tool" } }],
])("normalizes boolean visible replies %#", (messages, expected) => {
  expect(validateConfigObjectRaw({ messages })).toMatchObject({
    ok: true,
    config: { messages: expected },
  });
});

test.each([
  [{ visibleReplies: "visible" }, "messages.visibleReplies"],
  [{ groupChat: { unmentionedInbound: true } }, "messages.groupChat.unmentionedInbound"],
])("rejects unsupported messages %j at %s", (messages, path) => {
  expect(validateConfigObjectRaw({ messages })).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([expect.objectContaining({ path })]),
  });
});

test("rejects a relative worktreeRoot", () => {
  expect(accepts({ worktreeRoot: "worktrees" })).toBe(false);
});

test("validates the realtime input transcription model as an optional string", () => {
  const providers = { openai: { inputTranscriptionModel: "transcribe-prod" } };
  expect(validated({ talk: { realtime: { providers } } }).talk?.realtime?.providers).toEqual(
    providers,
  );
  expectSchemaIssue(
    { talk: { realtime: { providers: { openai: { inputTranscriptionModel: 123 } } } } },
    ["talk", "realtime", "providers", "openai", "inputTranscriptionModel"],
  );
});
