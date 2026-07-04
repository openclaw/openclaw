import { describe, expect, it, vi } from "vitest";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import type { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import {
  createCredentialBrokerSafeConfigGetter,
  createCredentialBrokerClient,
  hasConfiguredBrokeredSecretInputs,
  omitConfiguredBrokeredSecretInputs,
  projectConfiguredBrokeredSecretInputs,
} from "./credential-broker.js";
import type { PluginManifestCredentialBrokerOperation } from "./manifest.js";

const SECRET = "broker-test-secret-value";
const SECRET_REF: SecretRef = {
  source: "env",
  provider: "default",
  id: "BROKER_TEST_TOKEN",
};
const OPERATION: PluginManifestCredentialBrokerOperation = {
  id: "search",
  tool: "tavily_search",
  secretInputPath: "webSearch.apiKey",
  baseUrlConfigPath: "webSearch.baseUrl",
  baseUrlEnv: "TAVILY_BASE_URL",
  defaultBaseUrl: "https://api.example.test",
  path: "/search",
  method: "POST",
  credentialHeader: "Authorization",
  credentialScheme: "Bearer",
  headers: { "X-Client-Source": "openclaw" },
  maxRequestBodyBytes: 1024,
  maxResponseBodyBytes: 4096,
  timeoutMs: 5000,
};

function createConfig(params?: {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: "coding";
  baseUrl?: string | null;
  senderDeny?: string[];
}): OpenClawConfig {
  return {
    tools: {
      allow: params?.allow,
      alsoAllow: params?.alsoAllow,
      deny: params?.deny,
      profile: params?.profile,
      ...(params?.senderDeny ? { toolsBySender: { "id:alice": { deny: params.senderDeny } } } : {}),
    },
    plugins: {
      entries: {
        tavily: {
          config: {
            webSearch: {
              apiKey: SECRET_REF,
              baseUrl:
                params?.baseUrl === null
                  ? undefined
                  : (params?.baseUrl ?? "https://api.example.test/v1"),
            },
          },
        },
      },
    },
  };
}

function createProfile(config: OpenClawConfig) {
  return resolveConversationCapabilityProfile({
    config,
    sessionKey: "agent:main:discord:direct:alice",
    agentId: "main",
    messageProvider: "discord",
    messageChannel: "discord",
    chatType: "direct",
    senderId: "alice",
    workspaceDir: "/tmp/openclaw-broker-test",
  });
}

function createRuntimeConfig(sourceConfig: OpenClawConfig, credential: unknown = SECRET) {
  const runtimeConfig = structuredClone(sourceConfig);
  const pluginConfig = runtimeConfig.plugins?.entries?.tavily?.config as {
    webSearch?: { apiKey?: unknown };
  };
  if (pluginConfig.webSearch) {
    pluginConfig.webSearch.apiKey = credential;
  }
  return runtimeConfig;
}

function createFixture(params?: {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: "coding";
  baseUrl?: string | null;
  senderDeny?: string[];
  now?: () => number;
  response?: Response;
  runtimeCredential?: unknown;
  fetchError?: unknown;
  env?: NodeJS.ProcessEnv;
  defaultEnabled?: boolean;
}) {
  const config = createConfig(params);
  const runtimeConfig = createRuntimeConfig(config, params?.runtimeCredential ?? SECRET);
  const release = vi.fn(async () => {});
  const fetchGuard = vi.fn(
    async (
      options: Parameters<typeof withTrustedWebToolsEndpoint>[0],
      run: (result: { response: Response; finalUrl: string }) => Promise<unknown>,
    ) => {
      if (params?.fetchError) {
        throw params.fetchError;
      }
      try {
        const response =
          params?.response ??
          Response.json({
            echo: `prefix ${SECRET} suffix`,
            results: [],
          });
        return await run({ response, finalUrl: options.url });
      } finally {
        await release();
      }
    },
  );
  const broker = createCredentialBrokerClient({
    pluginId: "tavily",
    operations: [OPERATION],
    registrationToolNames: ["tavily_search"],
    defaultToolNames: params?.defaultEnabled === false ? [] : ["tavily_search"],
    context: {
      profile: createProfile(config),
      sourceConfig: config,
      runtimeConfig,
    },
    deps: {
      now: params?.now ?? (() => 0),
      randomUUID: () => "request-id",
      withTrustedWebToolsEndpoint: fetchGuard as typeof withTrustedWebToolsEndpoint,
      env: params?.env ?? {},
    },
  });
  return { broker, fetchGuard, release };
}

describe("credential broker", () => {
  it("handles array-index secret paths without exposing resolved values", () => {
    const operation = { ...OPERATION, secretInputPath: "accounts.0.apiKey" };
    const plugin = { id: "tavily", credentialBroker: { operations: [operation] } };
    const sourceConfig = {
      plugins: {
        entries: {
          tavily: { config: { accounts: [{ apiKey: SECRET_REF, label: "primary" }] } },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = structuredClone(sourceConfig);
    const runtimeAccounts = (
      runtimeConfig.plugins?.entries?.tavily?.config as {
        accounts: Array<{ apiKey?: unknown }>;
      }
    ).accounts;
    runtimeAccounts[0]!.apiKey = SECRET;

    expect(hasConfiguredBrokeredSecretInputs({ sourceConfig, plugins: [plugin] })).toBe(true);
    expect(
      JSON.stringify(
        omitConfiguredBrokeredSecretInputs({
          config: runtimeConfig,
          sourceConfig,
          plugins: [plugin],
        }),
      ),
    ).not.toContain(SECRET);
    const projected = projectConfiguredBrokeredSecretInputs({
      config: runtimeConfig,
      sourceConfig,
      plugins: [plugin],
    });
    const projectedCredential = (
      projected.plugins?.entries?.tavily?.config as {
        accounts: Array<{ apiKey?: unknown }>;
      }
    ).accounts[0]?.apiKey as SecretRef;
    expect(projectedCredential).toEqual(SECRET_REF);
    expect(projectedCredential).not.toBe(SECRET_REF);
    projectedCredential.id = "PLUGIN_MUTATED_TOKEN";
    expect(hasConfiguredBrokeredSecretInputs({ sourceConfig, plugins: [plugin] })).toBe(true);

    const getSafeConfig = createCredentialBrokerSafeConfigGetter({
      getRuntimeConfig: () => runtimeConfig,
      preparedConfig: sourceConfig,
      plugins: [plugin],
    });
    const safeCredential = (
      getSafeConfig().plugins?.entries?.tavily?.config as {
        accounts: Array<{ apiKey?: unknown }>;
      }
    ).accounts[0]?.apiKey as SecretRef;
    expect(safeCredential).toEqual(SECRET_REF);
    expect(safeCredential).not.toBe(SECRET_REF);
    safeCredential.id = "PLUGIN_MUTATED_AGAIN";
    expect(
      (
        getSafeConfig().plugins?.entries?.tavily?.config as {
          accounts: Array<{ apiKey?: unknown }>;
        }
      ).accounts[0]?.apiKey,
    ).toEqual(SECRET_REF);
    expect(hasConfiguredBrokeredSecretInputs({ sourceConfig, plugins: [plugin] })).toBe(true);
  });

  it("keeps credentials inside a scoped, single-use request", async () => {
    const fixture = createFixture({ allow: ["tavily_search"] });

    const handle = fixture.broker.createRequest({
      operationId: "search",
      body: { query: "team status" },
    });

    expect(JSON.stringify(fixture.broker)).not.toContain(SECRET);
    expect(JSON.stringify(handle)).toBe(
      '{"id":"request-id","operationId":"search","expiresAtMs":30000,"state":"pending"}',
    );

    await expect(handle.execute()).resolves.toEqual({
      status: 200,
      body: { echo: "prefix [REDACTED] suffix", results: [] },
    });
    expect(fixture.fetchGuard).toHaveBeenCalledOnce();
    const request = fixture.fetchGuard.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: "https://api.example.test/v1/search",
      requireHttps: true,
      maxRedirects: 0,
      capture: false,
      timeoutMs: 5000,
      auditContext: "credential-broker:tavily:search",
      init: {
        method: "POST",
        body: '{"query":"team status"}',
      },
    });
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(headers.get("x-client-source")).toBe("openclaw");
    expect(fixture.release).toHaveBeenCalledOnce();
    await expect(handle.execute()).rejects.toThrow("already consumed");
  });

  it("preserves default tool access while denying absent, conflicting, and sender grants", () => {
    expect(() =>
      createFixture().broker.createRequest({ operationId: "search", body: {} }),
    ).not.toThrow();
    for (const fixture of [
      createFixture({ defaultEnabled: false }),
      createFixture({ allow: ["tavily_search"], deny: ["tavily"] }),
      createFixture({ allow: ["tavily"], senderDeny: ["group:plugins"] }),
    ]) {
      expect(() => fixture.broker.createRequest({ operationId: "search", body: {} })).toThrow(
        "denied this conversation capability profile",
      );
      expect(fixture.fetchGuard).not.toHaveBeenCalled();
    }
  });

  it("uses the effective profile policy after alsoAllow is merged", async () => {
    const fixture = createFixture({ profile: "coding", alsoAllow: ["tavily_search"] });
    const handle = fixture.broker.createRequest({ operationId: "search", body: {} });

    await expect(handle.execute()).resolves.toMatchObject({ status: 200 });
  });

  it.each([
    ["agent", { serviceIdentity: { agentId: undefined } }],
    ["conversation", { conversation: { sessionKey: undefined } }],
    ["channel", { conversation: { messageChannel: undefined, messageProvider: undefined } }],
    ["sender", { sender: { id: undefined } }],
  ])("requires prepared %s scope", (_label, profilePatch) => {
    const config = createConfig({ allow: ["tavily_search"] });
    const profile = createProfile(config);
    const patchedProfile = {
      ...profile,
      ...profilePatch,
      serviceIdentity: {
        ...profile.serviceIdentity,
        ...("serviceIdentity" in profilePatch ? profilePatch.serviceIdentity : {}),
      },
      conversation: {
        ...profile.conversation,
        ...("conversation" in profilePatch ? profilePatch.conversation : {}),
      },
      sender: { ...profile.sender, ...("sender" in profilePatch ? profilePatch.sender : {}) },
    };
    const broker = createCredentialBrokerClient({
      pluginId: "tavily",
      operations: [OPERATION],
      registrationToolNames: ["tavily_search"],
      defaultToolNames: ["tavily_search"],
      context: {
        profile: patchedProfile,
        sourceConfig: config,
        runtimeConfig: createRuntimeConfig(config),
      },
    });

    expect(() => broker.createRequest({ operationId: "search", body: {} })).toThrow(
      "requires prepared agent, conversation, channel, and sender scope",
    );
  });

  it("validates destination before resolving credentials", async () => {
    const fixture = createFixture({
      allow: ["tavily_search"],
      baseUrl: "http://api.example.test",
    });

    const handle = fixture.broker.createRequest({ operationId: "search", body: {} });
    await expect(handle.execute()).rejects.toThrow(
      "destination must be a credential-free HTTPS base URL",
    );
    expect(fixture.fetchGuard).not.toHaveBeenCalled();
  });

  it("fails closed without the runtime snapshot paired to the SecretRef", () => {
    const config = createConfig({ allow: ["tavily_search"] });
    const broker = createCredentialBrokerClient({
      pluginId: "tavily",
      operations: [OPERATION],
      registrationToolNames: ["tavily_search"],
      defaultToolNames: ["tavily_search"],
      context: {
        profile: createProfile(config),
        sourceConfig: config,
      },
    });

    expect(() => broker.createRequest({ operationId: "search", body: {} })).toThrow(
      "requires a paired runtime credential snapshot",
    );
  });

  it("uses the declared destination environment fallback after config", async () => {
    const fixture = createFixture({
      allow: ["tavily_search"],
      baseUrl: null,
      env: { TAVILY_BASE_URL: "https://proxy.example.test/tavily" },
    });
    const handle = fixture.broker.createRequest({ operationId: "search", body: {} });

    await handle.execute();

    expect(fixture.fetchGuard.mock.calls[0]?.[0].url).toBe(
      "https://proxy.example.test/tavily/search",
    );
  });

  it("expires and revokes handles deterministically", async () => {
    let now = 100;
    const expired = createFixture({ allow: ["tavily_search"], now: () => now });
    const expiredHandle = expired.broker.createRequest({ operationId: "search", body: {} });
    now = expiredHandle.expiresAtMs;
    await expect(expiredHandle.execute()).rejects.toThrow("handle expired");
    expect(expired.fetchGuard).not.toHaveBeenCalled();
    expect(expiredHandle.toJSON().state).toBe("revoked");

    const revoked = createFixture({ allow: ["tavily_search"] });
    const revokedHandle = revoked.broker.createRequest({ operationId: "search", body: {} });
    revokedHandle.revoke();
    await expect(revokedHandle.execute()).rejects.toThrow("handle was revoked");
    expect(revoked.fetchGuard).not.toHaveBeenCalled();
  });

  it("rejects oversized and non-serializable bodies without retaining them", () => {
    const fixture = createFixture({ allow: ["tavily_search"] });
    expect(() =>
      fixture.broker.createRequest({ operationId: "search", body: "x".repeat(1024) }),
    ).toThrow("request body exceeds its declared limit");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => fixture.broker.createRequest({ operationId: "search", body: circular })).toThrow(
      "request body must be JSON serializable",
    );
    expect(fixture.fetchGuard).not.toHaveBeenCalled();
  });

  it("does not expose credential lookup or network failure details", async () => {
    const config = createConfig({ allow: ["tavily_search"] });
    const broker = createCredentialBrokerClient({
      pluginId: "tavily",
      operations: [OPERATION],
      registrationToolNames: ["tavily_search"],
      defaultToolNames: ["tavily_search"],
      context: {
        profile: createProfile(config),
        sourceConfig: config,
        runtimeConfig: createRuntimeConfig(config, SECRET_REF),
      },
    });

    const handle = broker.createRequest({ operationId: "search", body: {} });
    let message = "";
    try {
      await handle.execute();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Credential broker could not resolve operation credentials.");
    expect(message).not.toContain(SECRET);

    const failedRequest = createFixture({
      allow: ["tavily_search"],
      fetchError: new Error(SECRET),
    });
    const failedHandle = failedRequest.broker.createRequest({ operationId: "search", body: {} });
    await expect(failedHandle.execute()).rejects.toThrow(
      "Credential broker request failed before receiving a response.",
    );
  });

  it("contains header validation failures without exposing the credential", async () => {
    const invalidCredential = `${SECRET}\nsecond-line`;
    const fixture = createFixture({
      allow: ["tavily_search"],
      runtimeCredential: invalidCredential,
    });
    const handle = fixture.broker.createRequest({ operationId: "search", body: {} });

    let message = "";
    try {
      await handle.execute();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Credential broker could not prepare operation credentials.");
    expect(message).not.toContain(invalidCredential);
    expect(fixture.fetchGuard).not.toHaveBeenCalled();
  });

  it("redacts credentials from response property names", async () => {
    const fixture = createFixture({
      allow: ["tavily_search"],
      response: new Response(`{"prefix-${SECRET}":"value","__proto__":{"nested":"${SECRET}"}}`, {
        status: 200,
      }),
    });
    const handle = fixture.broker.createRequest({ operationId: "search", body: {} });

    const result = await handle.execute();

    expect(JSON.stringify(result.body)).not.toContain(SECRET);
    expect(Object.keys(result.body as object)).toContain("prefix-[REDACTED]");
  });

  it.each([
    { credential: "1234", responseBody: '{"echo":1234}' },
    { credential: "1e3", responseBody: '{"echo":1e3}' },
    { credential: "1.0", responseBody: '{"echo":1.0}' },
    { credential: "-0", responseBody: '{"echo":-0}' },
    { credential: "true", responseBody: '{"echo":true}' },
    { credential: "null", responseBody: '{"echo":null}' },
    { credential: '"json-string-secret"', responseBody: '{"echo":"json-string-secret"}' },
    {
      credential: '{"token":"json-object-secret"}',
      responseBody: '{"echo":{"token":"json-object-secret"}}',
    },
    { credential: '["json-array-secret",1]', responseBody: '{"echo":["json-array-secret",1]}' },
  ])("redacts a credential echoed as a parsed JSON value", async ({ credential, responseBody }) => {
    const fixture = createFixture({
      allow: ["tavily_search"],
      runtimeCredential: credential,
      response: new Response(responseBody, { status: 200 }),
    });
    const handle = fixture.broker.createRequest({ operationId: "search", body: {} });

    await expect(handle.execute()).resolves.toEqual({
      status: 200,
      body: { echo: "[REDACTED]" },
    });
  });
});
