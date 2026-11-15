import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  respondJson,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { clearAuthProfileMigrationDiagnostics } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import {
  closeAuthProfileReadPool,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { UnresolvedSecretInputError } from "../config/types.secrets.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getEmbeddingProvider } from "./embedding-provider-runtime.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-provider-types.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

type Remote = NonNullable<EmbeddingProviderCreateOptions["remote"]>;
type Options = EmbeddingProviderCreateOptions & { provider: string };
const vector = [0.25, 0.5, 0.75];
const boundKey = "synthetic-bound-profile-key";
let server: Server;
let baseUrl: string;
let fixtureAgentDir: string;
let requests: Array<{ url?: string; headers: IncomingHttpHeaders }>;

beforeEach(async () => {
  fixtureAgentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-embedding-"));
  vi.stubEnv("NO_PROXY", "127.0.0.1");
  vi.stubEnv("no_proxy", "127.0.0.1");
  vi.stubEnv("OPENCLAW_TEST_EMBEDDING_LITERAL_KEY", "ambient-key-bait");
  vi.stubEnv("OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER", "ambient-header-bait");
  requests = [];
  server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      requests.push({ url: request.url, headers: request.headers });
      respondJson(response, { data: [{ index: 0, embedding: vector }] });
    });
  });
  baseUrl = `${await listenLoopback(server)}/v1`;
});

afterEach(async () => {
  closeAuthProfileReadPool({ kind: "root", rootPath: fixtureAgentDir });
  closeOpenClawAgentDatabases(fixtureAgentDir);
  await rm(fixtureAgentDir, { force: true, recursive: true });
  vi.unstubAllEnvs();
  await closeHttpServer(server);
});

function createOptions(
  params: {
    providerOwnsDestination?: boolean;
    providerBaseUrl?: string;
    providerApiKey?: Remote["apiKey"];
    remote?: Remote;
    agentDir?: string;
  } = {},
): Options {
  return {
    ...providerOptions({
      baseUrl:
        params.providerBaseUrl ??
        (params.providerOwnsDestination !== false ? baseUrl : "https://provider.example.test/v1"),
      apiKey: params.providerApiKey ?? "synthetic-provider-key",
      headers: { "X-Provider-Tenant": "provider-tenant", "X-Shared": "provider-value" },
    }),
    model: "tenant-embeddings/fixture-model",
    remote: { baseUrl, ...params.remote },
    agentDir: params.agentDir,
  };
}

function providerOptions(
  entry: Partial<ModelProviderConfig>,
  provider = "tenant-embeddings",
  agentDir?: string,
): Options {
  const configured = { api: "openai-completions" as const, baseUrl, models: [], ...entry };
  return {
    config: { models: { providers: { [provider]: configured } } },
    provider,
    agentDir,
    model: "fixture-model",
  };
}

function writeProfile(profileId: string, credential: AuthProfileCredential) {
  writePersistedAuthProfileStoreRaw(
    { version: 1, profiles: { [profileId]: credential } },
    fixtureAgentDir,
  );
}

function envSecret(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function boundCredential(provider: string, type: "api_key" | "token" = "api_key", key = boundKey) {
  return type === "api_key" ? { type, provider, key } : { type, provider, token: key };
}

async function embed(options: EmbeddingProviderCreateOptions) {
  const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
  return result.provider?.embed("hello");
}

async function expectEmbedding(result: Promise<unknown>, authorization?: string) {
  await expect(result).resolves.toEqual(vector);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.headers.authorization).toBe(authorization);
}

function explicitOwners(agentDir?: string) {
  return {
    ownership: "explicit" as const,
    entries: { ops: {}, research: agentDir ? { agentDir } : {} },
  };
}

const remoteKey = "synthetic-remote-key";
const remoteHeader = "Bearer synthetic-remote-header";
const remoteTenant = { "X-Remote-Tenant": "remote-tenant" };
const providerHeaders = { "x-provider-tenant": "provider-tenant", "x-shared": "provider-value" };
const remoteAuth = { headers: { Authorization: remoteHeader } };
const remoteCredentials = { apiKey: remoteKey, headers: remoteTenant };
const remoteTenantHeaders = { "x-remote-tenant": "remote-tenant" };
const remoteBearer = `Bearer ${remoteKey}`;
function httpCase(
  name: string,
  remote: Remote,
  authorization?: string,
  expectedHeaders: Record<string, string> = {},
  destination = "different",
) {
  return { name, remote, authorization, expectedHeaders, destination };
}
it.each([
  httpCase(
    "owned headers",
    { headers: { "X-Shared": "remote-value" } },
    "Bearer synthetic-provider-key",
    { ...providerHeaders, "x-shared": "remote-value" },
    "owned",
  ),
  httpCase("owned Authorization", remoteAuth, remoteHeader, providerHeaders, "owned"),
  httpCase("remote key", remoteCredentials, remoteBearer, remoteTenantHeaders),
  httpCase("query URL", remoteCredentials, remoteBearer, remoteTenantHeaders, "query"),
  httpCase("remote Authorization", remoteAuth, remoteHeader),
  httpCase("remote api-key", { headers: { "api-key": "synthetic-destination-key" } }, undefined, {
    "api-key": "synthetic-destination-key",
  }),
  httpCase("unauthenticated remote", {}),
  httpCase(
    "remote Authorization overrides remote key",
    {
      apiKey: "synthetic-ignored-remote-key",
      headers: { Authorization: "Custom synthetic-remote-header" },
    },
    "Custom synthetic-remote-header",
  ),
  httpCase(
    "template-looking credentials reach HTTP literally",
    {
      apiKey: "${OPENCLAW_TEST_EMBEDDING_LITERAL_KEY}",
      headers: { "X-Literal": "$OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER" },
    },
    "Bearer ${OPENCLAW_TEST_EMBEDDING_LITERAL_KEY}",
    { "x-literal": "$OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER" },
  ),
])(
  "isolates HTTP credentials: $name",
  async ({ destination, remote, authorization, expectedHeaders }) => {
    const query = destination === "query";
    const options = createOptions({
      providerOwnsDestination: destination === "owned",
      ...(query ? { providerBaseUrl: `${baseUrl}?tenant=provider` } : {}),
      remote: query ? { ...remote, baseUrl: `${baseUrl}?tenant=remote` } : remote,
    });
    await expectEmbedding(embed(options), authorization);
    expect(requests[0]).toMatchObject({
      url: `/v1/embeddings${query ? "?tenant=remote" : ""}`,
      headers: expectedHeaders,
    });
    if (destination !== "owned") {
      expect(requests[0]?.headers).not.toHaveProperty("x-provider-tenant");
      expect(requests[0]?.headers).not.toHaveProperty("x-shared");
    }
  },
);

it("uses a literal provider key without selecting an agent owner", async () => {
  const options = createOptions();
  options.config.agents = explicitOwners();
  await expectEmbedding(embed(options), "Bearer synthetic-provider-key");
});

it.each(["llama-cpp", "llmman"])(
  "honors managed %s auth with a retained missing SecretRef at HTTP",
  async (provider) => {
    const ref = envSecret("MISSING_MANAGED_EMBEDDING_KEY");
    vi.stubEnv(ref.id, undefined);
    vi.stubEnv("LLMMAN_API_KEY", "synthetic-env-fallback");
    const options = providerOptions(
      { apiKey: ref, localService: { command: "/fixture/server" } },
      provider,
    );
    if (provider === "llmman") {
      await expect(embed(options)).rejects.toBeInstanceOf(UnresolvedSecretInputError);
      expect(requests).toEqual([]);
    } else {
      await expect(embed(options)).resolves.toEqual(vector);
      expect(requests[0]?.headers.authorization).toBe("Bearer llama-cpp-local");
      expect(options.config.models?.providers?.[provider]?.apiKey).toEqual(ref);
    }
  },
);

it.each([false, true])(
  "keeps metadata-only profile names literal with owned store = %s",
  async (ownedStore) => {
    const profileId = "tenant-embeddings:metadata-only";

    const options = createOptions({ providerApiKey: profileId });
    options.config.agents = explicitOwners();
    options.config.auth = {
      profiles: { [profileId]: { provider: "tenant-embeddings", mode: "api_key" } },
    };
    if (ownedStore) {
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, fixtureAgentDir);
      options.agentDir = fixtureAgentDir;
    }
    await expectEmbedding(embed(options), `Bearer ${profileId}`);
  },
);

it.each([
  { cache: "cold", populated: false },
  { cache: "warm", populated: false },
  { cache: "warm", populated: true },
])(
  "honors recreated legacy auth with $cache cache and populated SQLite = $populated",
  async ({ cache, populated }) => {
    await withOpenClawTestState(
      { layout: "state-only", label: "embedding-auth-migration" },
      async (state) => {
        const agentDir = state.agentDir("worker");
        const profileId = "tenant-embeddings:restored";
        const credential = boundCredential(
          "tenant-embeddings",
          "api_key",
          "synthetic-canonical-profile-key",
        );
        const store: AuthProfileStore = {
          version: 1,
          profiles: populated ? { [profileId]: credential } : {},
        };
        try {
          writePersistedAuthProfileStoreRaw(store, agentDir);
          clearRuntimeAuthProfileStoreSnapshots();
          if (cache === "warm") {
            setRuntimeAuthProfileStoreSnapshot(store, agentDir);
          }
          await state.writeJson("agents/worker/agent/auth-profiles.json", {
            version: 1,
            profiles: {
              [profileId]: { ...credential, key: "synthetic-restored-profile-key" },
            },
          });
          const options = createOptions({ providerApiKey: profileId, agentDir });
          if (populated) {
            await expectEmbedding(embed(options), "Bearer synthetic-canonical-profile-key");
          } else {
            await expect.soft(embed(options)).rejects.toMatchObject({
              code: "AUTH_PROFILE_MIGRATION_REQUIRED",
              action: "openclaw doctor --fix",
            });
            expect(requests).toEqual([]);
          }
        } finally {
          clearAuthProfileMigrationDiagnostics();
          clearRuntimeAuthProfileStoreSnapshots();
          closeOpenClawAgentDatabases(agentDir);
        }
      },
    );
  },
);

it.each([
  { provider: "openai", api: "openai-responses", credentialType: "api_key" },
  { provider: "openai", api: "openai-completions", credentialType: "token" },
  { provider: "tenant-embeddings", api: "openai-responses", credentialType: "token" },
  { provider: "tenant-embeddings", api: "openai-completions", credentialType: "api_key" },
] as const)(
  "enforces $provider/$api $credentialType profile auth with plugins disabled",
  async ({ provider, api, credentialType }) => {
    const profileId = `${provider}:bound`;
    writeProfile(profileId, boundCredential(provider, credentialType));
    const options = providerOptions({ api, apiKey: profileId }, provider, fixtureAgentDir);
    options.config.plugins = { enabled: false };
    const adapter = getEmbeddingProvider(provider, options.config);
    expect(adapter).toBe(openAICompatibleEmbeddingProviderAdapter);
    const send = async () => (await adapter!.create(options)).provider?.embed("hello");
    if (provider === "openai" && credentialType === "token") {
      await expect.soft(send()).rejects.toThrow(/requires an OpenAI API key profile/);
      expect(requests).toEqual([]);
    } else {
      await expectEmbedding(send(), `Bearer ${boundKey}`);
    }
  },
);

it.each([
  { route: "bearer control", binding: "incompatible" },
  { route: "bearer control", binding: "unresolved" },
  { route: "AWS override", binding: "compatible" },
  { route: "AWS order", binding: "incompatible" },
  { route: "AWS order", binding: "unresolved" },
] as const)("keeps $binding profile bindings terminal with $route", async ({ route, binding }) => {
  const profileId = "tenant-embeddings:bound";
  writeProfile(
    profileId,
    binding === "unresolved"
      ? { type: "api_key", provider: "tenant-embeddings" }
      : boundCredential(binding === "incompatible" ? "other-tenant" : "tenant-embeddings"),
  );
  const options = createOptions({ providerApiKey: profileId, agentDir: fixtureAgentDir });
  if (route !== "bearer control") {
    options.config.models!.providers![options.provider]!.auth = "aws-sdk";
  }
  if (route === "AWS order") {
    options.config.auth = {
      profiles: { "tenant-embeddings:aws": { provider: options.provider, mode: "aws-sdk" } },
      order: { [options.provider]: ["tenant-embeddings:aws"] },
    };
  }
  if (binding === "compatible") {
    await expectEmbedding(embed(options), `Bearer ${boundKey}`);
  } else {
    const failure =
      binding === "incompatible"
        ? /not compatible with this provider entry's auth binding/
        : /matched a stored profile but failed to resolve/;
    await expect.soft(embed(options)).rejects.toThrow(failure);
    expect(requests).toEqual([]);
  }
});

it.each([
  ["profile reference", "tenant-embeddings:default", "Bearer synthetic-profile-key"],
  ["literal key", "synthetic-literal-key", "Bearer synthetic-literal-key"],
  ["whitespace key", "   ", undefined],
  ["omitted key", undefined, undefined],
])("keeps %s authentication with auth.order at HTTP", async (_name, apiKey, authorization) => {
  const profileId = "tenant-embeddings:default";

  writeProfile(profileId, boundCredential("tenant-embeddings", "api_key", "synthetic-profile-key"));
  const options = providerOptions({ apiKey }, "tenant-embeddings", fixtureAgentDir);
  options.model = "tenant-embeddings/fixture-model";
  options.config.auth = {
    profiles: { [profileId]: { provider: "tenant-embeddings", mode: "api_key" } },
    order: { "tenant-embeddings": [profileId] },
  };
  options.config.agents = explicitOwners(fixtureAgentDir);
  await expectEmbedding(embed(options), authorization);
});

it.each(["apiKey", "header", "providerApiKey"])(
  "rejects an unresolved %s before egress",
  async (field) => {
    vi.stubEnv("OPENCLAW_TEST_EMBEDDING_UNRESOLVED_SECRET", "ambient-secret-bait");
    const ref = envSecret("OPENCLAW_TEST_EMBEDDING_UNRESOLVED_SECRET");
    const remote: Remote =
      field === "apiKey"
        ? { apiKey: ref }
        : { apiKey: "synthetic-remote-key", headers: { "X-Remote-Secret": "" } };
    if (field === "header") {
      Object.assign(remote.headers ?? {}, { "X-Remote-Secret": ref });
    }

    const options = createOptions({
      providerOwnsDestination: true,
      providerApiKey: field === "providerApiKey" ? ref : undefined,
      remote: field === "providerApiKey" ? {} : remote,
    });
    await expect.soft(embed(options)).rejects.toBeInstanceOf(UnresolvedSecretInputError);
    expect(requests).toEqual([]);
  },
);
