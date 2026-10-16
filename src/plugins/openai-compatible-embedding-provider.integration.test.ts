import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import {
  resolveApiKeyForProviderCore,
  resolveScopedAuthProfileStore,
} from "../agents/model-auth-provider.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { UnresolvedSecretInputError } from "../config/types.secrets.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getEmbeddingProvider } from "./embedding-provider-runtime.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-provider-types.js";
import { openAICompatibleEmbeddingProviderAdapter } from "./openai-compatible-embedding-provider.js";

const vector = [0.25, 0.5, 0.75];
let server: Server;
let baseUrl: string;
let requests: Array<{ url?: string; headers: IncomingHttpHeaders }>;

beforeEach(async () => {
  vi.stubEnv("NO_PROXY", "127.0.0.1");
  vi.stubEnv("no_proxy", "127.0.0.1");
  vi.stubEnv("OPENCLAW_TEST_EMBEDDING_LITERAL_KEY", "ambient-key-bait");
  vi.stubEnv("OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER", "ambient-header-bait");
  requests = [];
  server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      requests.push({ url: request.url, headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: vector }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("embedding fixture did not expose a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function createOptions(params: {
  providerOwnsDestination?: boolean;
  providerBaseUrl?: string;
  providerApiKey?: NonNullable<EmbeddingProviderCreateOptions["remote"]>["apiKey"];
  remote: NonNullable<EmbeddingProviderCreateOptions["remote"]>;
}): EmbeddingProviderCreateOptions & { provider: string } {
  return {
    ...providerOptions({
      baseUrl:
        params.providerBaseUrl ??
        (params.providerOwnsDestination ? baseUrl : "https://provider.example.test/v1"),
      apiKey: params.providerApiKey ?? "synthetic-provider-key",
      headers: { "X-Provider-Tenant": "provider-tenant", "X-Shared": "provider-value" },
    }),
    model: "tenant-embeddings/fixture-model",
    remote: { baseUrl, ...params.remote },
  };
}

function providerOptions(
  entry: Partial<ModelProviderConfig>,
  provider = "tenant-embeddings",
  agentDir?: string,
): EmbeddingProviderCreateOptions & { provider: string } {
  return {
    config: {
      models: {
        providers: {
          [provider]: {
            api: "openai-completions",
            baseUrl,
            models: [],
            ...entry,
          },
        },
      },
    },
    provider,
    agentDir,
    model: "fixture-model",
  };
}

function writeProfile(agentDir: string, profileId: string, credential: AuthProfileCredential) {
  writePersistedAuthProfileStoreRaw(
    { version: 1, profiles: { [profileId]: credential } },
    agentDir,
  );
}

function ownedOptions(providerApiKey = "synthetic-provider-key", agentDir?: string) {
  return {
    ...createOptions({ providerOwnsDestination: true, providerApiKey, remote: {} }),
    agentDir,
  };
}

async function withAgentDir(label: string, run: (agentDir: string) => Promise<void>) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), `openclaw-embedding-${label}-`));
  try {
    await run(agentDir);
  } finally {
    closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
    closeOpenClawAgentDatabases(agentDir);
    await rm(agentDir, { force: true, recursive: true });
  }
}

async function embed(options: EmbeddingProviderCreateOptions) {
  const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
  return result.provider?.embed("hello");
}

function expectAuthorization(authorization: string | undefined) {
  expect(requests).toHaveLength(1);
  expect(requests[0]?.headers.authorization).toBe(authorization);
}

const remoteKey = "synthetic-remote-key";
const remoteHeader = "Bearer synthetic-remote-header";
const remoteTenant = { "X-Remote-Tenant": "remote-tenant" };
function credentialCase(
  name: string,
  remote: NonNullable<EmbeddingProviderCreateOptions["remote"]>,
  authorization?: string,
  expectedHeaders: Record<string, string> = {},
  destination = "different",
) {
  return { name, remote, authorization, expectedHeaders, destination };
}
it.each([
  credentialCase(
    "provider credentials and remote precedence",
    { headers: { "X-Shared": "remote-value" } },
    "Bearer synthetic-provider-key",
    { "x-provider-tenant": "provider-tenant", "x-shared": "remote-value" },
    "owned",
  ),
  credentialCase(
    "remote Authorization overrides provider key",
    { headers: { Authorization: remoteHeader } },
    remoteHeader,
    { "x-provider-tenant": "provider-tenant", "x-shared": "provider-value" },
    "owned",
  ),
  credentialCase(
    "different destination receives remote credentials",
    { apiKey: remoteKey, headers: remoteTenant },
    `Bearer ${remoteKey}`,
    { "x-remote-tenant": "remote-tenant" },
  ),
  credentialCase(
    "query-distinct destination excludes provider credentials",
    { apiKey: remoteKey, headers: remoteTenant },
    `Bearer ${remoteKey}`,
    { "x-remote-tenant": "remote-tenant" },
    "query",
  ),
  credentialCase(
    "different destination accepts Authorization",
    { headers: { Authorization: remoteHeader } },
    remoteHeader,
  ),
  credentialCase(
    "different destination accepts api-key",
    { headers: { "api-key": "synthetic-destination-key" } },
    undefined,
    { "api-key": "synthetic-destination-key" },
  ),
  credentialCase("different destination is unauthenticated", {}),
  credentialCase(
    "remote Authorization overrides remote key",
    {
      apiKey: "synthetic-ignored-remote-key",
      headers: { Authorization: "Custom synthetic-remote-header" },
    },
    "Custom synthetic-remote-header",
  ),
  credentialCase(
    "template-looking credentials reach HTTP literally",
    {
      apiKey: "${OPENCLAW_TEST_EMBEDDING_LITERAL_KEY}",
      headers: { "X-Literal": "$OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER" },
    },
    "Bearer ${OPENCLAW_TEST_EMBEDDING_LITERAL_KEY}",
    { "x-literal": "$OPENCLAW_TEST_EMBEDDING_LITERAL_HEADER" },
  ),
])("$name", async ({ destination, remote, authorization, expectedHeaders }) => {
  const queryDistinctDestination = destination === "query";
  const options = createOptions({
    providerOwnsDestination: destination === "owned",
    ...(queryDistinctDestination ? { providerBaseUrl: `${baseUrl}?tenant=provider` } : {}),
    remote: queryDistinctDestination ? { ...remote, baseUrl: `${baseUrl}?tenant=remote` } : remote,
  });
  await expect(embed(options)).resolves.toEqual(vector);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: `/v1/embeddings${queryDistinctDestination ? "?tenant=remote" : ""}`,
    headers: expectedHeaders,
  });
  expect(requests[0]?.headers.authorization).toBe(authorization);
  if (destination !== "owned") {
    expect(requests[0]?.headers).not.toHaveProperty("x-provider-tenant");
    expect(requests[0]?.headers).not.toHaveProperty("x-shared");
  }
});

it("uses a literal provider key without selecting an agent owner", async () => {
  const options = ownedOptions();
  options.config.agents = {
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  };
  await expect(embed(options)).resolves.toEqual(vector);
  expect(requests[0]?.headers.authorization).toBe("Bearer synthetic-provider-key");
});

it.each(["llama-cpp", "llmman"])(
  "honors managed %s auth with a retained missing SecretRef at HTTP",
  async (provider) => {
    const ref = {
      source: "env",
      provider: "default",
      id: "MISSING_MANAGED_EMBEDDING_KEY",
    } as const;
    vi.stubEnv(ref.id, undefined);
    vi.stubEnv("LLMMAN_API_KEY", "synthetic-env-fallback");
    const options = providerOptions(
      { apiKey: ref, localService: { command: "/fixture/server" } },
      provider,
    );
    const send = () => embed(options);
    if (provider === "llmman") {
      await expect(send()).rejects.toBeInstanceOf(UnresolvedSecretInputError);
      expect(requests).toEqual([]);
    } else {
      await expect(send()).resolves.toEqual(vector);
      expect(requests[0]?.headers.authorization).toBe("Bearer llama-cpp-local");
      expect(options.config.models?.providers?.[provider]?.apiKey).toEqual(ref);
    }
  },
);

it.each([false, true])(
  "keeps metadata-only profile names literal with owned store = %s",
  async (ownedStore) => {
    await withAgentDir("metadata", async (agentDir) => {
      const profileId = "tenant-embeddings:metadata-only";

      const options = ownedOptions(profileId);
      options.config.agents = {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      };
      options.config.auth = {
        profiles: { [profileId]: { provider: "tenant-embeddings", mode: "api_key" } },
      };
      if (ownedStore) {
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
        options.agentDir = agentDir;
        const authParams = { cfg: options.config, provider: options.provider, agentDir };
        const store = resolveScopedAuthProfileStore(authParams);
        expect(store.profiles[profileId]).toBeUndefined();
        await expect(resolveApiKeyForProviderCore({ ...authParams, store })).resolves.toMatchObject(
          {
            apiKey: profileId,
          },
        );
      }
      await expect(embed(options)).resolves.toEqual(vector);
      expect(requests[0]?.headers.authorization).toBe(`Bearer ${profileId}`);
    });
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
        const credential: AuthProfileCredential = {
          type: "api_key",
          provider: "tenant-embeddings",
          key: "synthetic-canonical-profile-key",
        };
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
          const options = ownedOptions(profileId, agentDir);
          const send = () => embed(options);
          if (populated) {
            await expect(send()).resolves.toEqual(vector);
            expectAuthorization("Bearer synthetic-canonical-profile-key");
          } else {
            await expect.soft(send()).rejects.toMatchObject({
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
    await withAgentDir("auth-mode", async (agentDir) => {
      const profileId = `${provider}:bound`;
      const credential: AuthProfileCredential =
        credentialType === "api_key"
          ? { type: credentialType, provider, key: "synthetic-bound-profile-key" }
          : { type: credentialType, provider, token: "synthetic-bound-profile-key" };

      writeProfile(agentDir, profileId, credential);
      const options = providerOptions({ api, apiKey: profileId }, provider, agentDir);
      options.config.plugins = { enabled: false };
      const adapter = getEmbeddingProvider(provider, options.config);
      expect(adapter).toBe(openAICompatibleEmbeddingProviderAdapter);
      const send = async () => (await adapter!.create(options)).provider?.embed("hello");
      if (provider === "openai" && credentialType === "token") {
        await expect.soft(send()).rejects.toThrow(/requires an OpenAI API key profile/);
        expect(requests).toEqual([]);
      } else {
        await expect(send()).resolves.toEqual(vector);
        expectAuthorization("Bearer synthetic-bound-profile-key");
      }
    });
  },
);

it.each([
  { route: "bearer control", binding: "incompatible" },
  { route: "bearer control", binding: "unresolved" },
  { route: "AWS override", binding: "compatible" },
  { route: "AWS order", binding: "incompatible" },
  { route: "AWS order", binding: "unresolved" },
] as const)("keeps $binding profile bindings terminal with $route", async ({ route, binding }) => {
  await withAgentDir("binding", async (agentDir) => {
    const profileId = "tenant-embeddings:bound";
    const credential: AuthProfileCredential = {
      type: "api_key",
      provider: binding === "incompatible" ? "other-tenant" : "tenant-embeddings",
      ...(binding === "unresolved" ? {} : { key: "synthetic-bound-profile-key" }),
    };

    writeProfile(agentDir, profileId, credential);
    const options = ownedOptions(profileId, agentDir);
    if (route !== "bearer control") {
      options.config.models!.providers![options.provider]!.auth = "aws-sdk";
    }
    if (route === "AWS order") {
      options.config.auth = {
        profiles: { "tenant-embeddings:aws": { provider: options.provider, mode: "aws-sdk" } },
        order: { [options.provider]: ["tenant-embeddings:aws"] },
      };
    }
    const send = () => embed(options);
    if (binding === "compatible") {
      await expect(send()).resolves.toEqual(vector);
      expect(requests[0]?.headers.authorization).toBe("Bearer synthetic-bound-profile-key");
    } else {
      await expect
        .soft(send())
        .rejects.toThrow(
          binding === "incompatible"
            ? /not compatible with this provider entry's auth binding/
            : /matched a stored profile but failed to resolve/,
        );
      expect(requests).toEqual([]);
    }
  });
});

it.each([
  {
    name: "profile reference",
    apiKey: "tenant-embeddings:default",
    authorization: "Bearer synthetic-profile-key",
  },
  {
    name: "literal key",
    apiKey: "synthetic-literal-key",
    authorization: "Bearer synthetic-literal-key",
  },
  { name: "whitespace key", apiKey: "   ", authorization: undefined },
  { name: "omitted key", apiKey: undefined, authorization: undefined },
])("keeps $name authentication with auth.order at HTTP", async ({ apiKey, authorization }) => {
  await withAgentDir("profile", async (agentDir) => {
    const profileId = "tenant-embeddings:default";

    writeProfile(agentDir, profileId, {
      type: "api_key",
      provider: "tenant-embeddings",
      key: "synthetic-profile-key",
    });
    const options = providerOptions({ apiKey }, "tenant-embeddings", agentDir);
    options.model = "tenant-embeddings/fixture-model";
    options.config.auth = {
      profiles: { [profileId]: { provider: "tenant-embeddings", mode: "api_key" } },
      order: { "tenant-embeddings": [profileId] },
    };
    options.config.agents = {
      ownership: "explicit",
      entries: { ops: {}, research: { agentDir } },
    };
    await expect(embed(options)).resolves.toEqual(vector);
    expectAuthorization(authorization);
  });
});

it.each(["apiKey", "header", "providerApiKey"])(
  "rejects an unresolved %s before egress",
  async (field) => {
    vi.stubEnv("OPENCLAW_TEST_EMBEDDING_UNRESOLVED_SECRET", "ambient-secret-bait");
    const ref = {
      source: "env" as const,
      provider: "default",
      id: "OPENCLAW_TEST_EMBEDDING_UNRESOLVED_SECRET",
    };
    const remote: NonNullable<EmbeddingProviderCreateOptions["remote"]> =
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
