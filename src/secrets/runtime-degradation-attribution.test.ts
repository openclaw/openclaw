/** Tests degraded-owner attribution during runtime SecretRef preparation. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.ts";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { prepareRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import type { SecretRef } from "../config/types.secrets.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import { listSecretResolutionErrorOwners } from "./runtime-degraded-state.js";
import {
  canonicalizeSecretRefsForOwnerContract,
  combineSecretOwnerContractDigests,
  digestSecretOwnerContract,
} from "./runtime-owner-contract.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envRef = (id: string): SecretRef => ({ source: "env", provider: "default", id });
const fileRef = (provider: string, id: string): SecretRef => ({ source: "file", provider, id });
const fileProvider = (filePath: string) => ({
  source: "file" as const,
  path: filePath,
  mode: "json" as const,
});
const models = (apiKey: SecretRef) => ({
  providers: { example: { apiKey, baseUrl: "https://example.invalid/v1", models: [] } },
});
const tts = (apiKey: SecretRef) => ({ providers: { elevenlabs: { apiKey } } });
const webSearch = (apiKey: SecretRef) => ({ config: { webSearch: { apiKey } } });
const authProfile = (keyRef: SecretRef) => ({
  type: "api_key" as const,
  provider: "openai",
  key: "dummy",
  keyRef,
});
async function writeSharedSecret(filePath: string, shared: unknown) {
  await fs.writeFile(filePath, JSON.stringify({ shared }), "utf8");
  await fs.chmod(filePath, 0o600);
}
function expectOwners(error: unknown, ...owners: object[]) {
  const expected = owners.map((owner) => expect.objectContaining(owner));
  expect(listSecretResolutionErrorOwners(error)).toEqual(expect.arrayContaining(expected));
}
function expectOnlyOwner(error: unknown, owner: object) {
  expect(listSecretResolutionErrorOwners(error)).toEqual([expect.objectContaining(owner)]);
}
const sharedSecrets = (filePath: string) => ({ providers: { shared: fileProvider(filePath) } });
const invalidValue = { reason: "resolved secret value was invalid", failureMatched: true };
function webConfig(ref: SecretRef, fetch = false, auto = false) {
  return {
    tools: {
      web: {
        search: auto ? { enabled: true } : { provider: "gemini" },
        ...(fetch ? { fetch: { provider: "firecrawl" } } : {}),
      },
    },
    plugins: {
      entries: {
        ...(auto ? { brave: webSearch(envRef("EARLIER_REF")) } : {}),
        google: webSearch(ref),
        ...(fetch ? { firecrawl: { config: { webFetch: { apiKey: ref } } } } : {}),
      },
    },
  };
}

type RuntimeConfig = ReturnType<typeof asConfig>;
type RuntimeSnapshot = Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>;
type PrepareOverrides = Omit<
  Parameters<typeof prepareSecretsRuntimeSnapshot>[0],
  "config" | "includeAuthStoreRefs" | "loadablePluginOrigins"
>;

function prepare(config: RuntimeConfig, overrides: PrepareOverrides = {}) {
  return prepareSecretsRuntimeSnapshot({
    config,
    ...overrides,
    includeAuthStoreRefs: false,
    loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
  });
}

async function captureFailure(config: RuntimeConfig, overrides: PrepareOverrides = {}) {
  return await prepare(config, overrides).catch((failure: unknown) => failure);
}

function activate(snapshot: RuntimeSnapshot): void {
  activateSecretsRuntimeSnapshotState({ snapshot, refreshContext: null, refreshHandler: null });
}
async function prepareActive(config: RuntimeConfig, overrides: PrepareOverrides = {}) {
  activate(await prepare(config, overrides));
}

function attachAuthOwner(params: {
  snapshot: RuntimeSnapshot;
  ref: SecretRef;
  refKey: string;
  contractDigest?: string;
  append?: boolean;
}): string {
  const agentDir = "/tmp/shared-secret-co-owner";
  const profileId = "openai:shared";
  const ownerId = resolveAuthProfileSecretOwnerId({ agentDir, profileId });
  const store = createAuthProfileStoreFixture({ [profileId]: authProfile(params.ref) });
  params.snapshot.authStores = prepareRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
  const owner = {
    ownerKind: "account" as const,
    ownerId,
    refKeys: [params.refKey],
    ...(params.contractDigest ? { contractDigest: params.contractDigest } : {}),
  };
  params.snapshot.secretOwners = [
    ...(params.append ? (params.snapshot.secretOwners ?? []) : []),
    owner,
  ];
  return ownerId;
}

describe("secrets runtime degraded-owner attribution", () => {
  it("fails closed for missing TTS SecretRefs outside cold-start isolation", async () => {
    const error = await captureFailure(
      asConfig({
        models: models(envRef("CURRENT_PROVIDER_REF")),
        tts: tts(envRef("ELEVENLABS_API_KEY")),
      }),
      { env: { CURRENT_PROVIDER_REF: "resolved" } },
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      'Environment variable "ELEVENLABS_API_KEY" is missing or empty.',
    );
    expectOnlyOwner(error, {
      ownerKind: "capability",
      ownerId: "tts",
      paths: ["tts.providers.elevenlabs.apiKey"],
      reason: "secret reference was not found",
      degradationState: "cold",
      failureMatched: true,
    });
  });

  it.each([
    ["tts", false],
    ["tts", true],
    ["explicit", false],
    ["explicit", true],
    ["auto", false],
  ] as const)("classifies %s reload (changed ref: %s)", async (mode, changed) => {
    const config = (id: string) =>
      asConfig(
        mode === "tts" ? { tts: tts(envRef(id)) } : webConfig(envRef(id), false, mode === "auto"),
      );
    await prepareActive(config("CURRENT_REF"), {
      env: { CURRENT_REF: "resolved" },
    });
    const error = await captureFailure(config(changed ? "CHANGED_REF" : "CURRENT_REF"), {
      env: {},
    });
    const owner = {
      ownerKind: "capability",
      ownerId: mode === "tts" ? "tts" : "web-search:gemini",
      degradationState: changed ? "cold" : "stale",
      ...(mode === "tts" ? {} : { failureMatched: true }),
    };
    (mode === "tts" ? expectOnlyOwner : expectOwners)(error, owner);
    if (mode === "auto") {
      expectOwners(error, {
        ownerId: "web-search:brave",
        degradationState: "cold",
      });
    }
  });

  it("attributes provider failures by source and provider before matching ref ids", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-secret-provider-owner-match-");
    const healthyPath = path.join(root, "healthy.json");
    await writeSharedSecret(healthyPath, "healthy");
    const sharedId = "/shared";
    const error = await captureFailure(
      asConfig({
        secrets: {
          providers: {
            missing: fileProvider(path.join(root, "missing.json")),
            healthy: fileProvider(healthyPath),
          },
        },
        models: models(fileRef("missing", sharedId)),
        tts: tts(fileRef("healthy", sharedId)),
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expectOnlyOwner(error, { ownerKind: "provider", ownerId: "example" });
  });

  it("includes active co-owners using another ref from a failed provider", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-secret-provider-active-co-owner-");
    const activeRef = fileRef("missing", "/active");
    const config = asConfig({
      secrets: { providers: { missing: fileProvider(path.join(root, "missing.json")) } },
      models: models(fileRef("missing", "/candidate")),
    });
    const active = await prepare(asConfig({}));
    active.sourceConfig = active.config = config;
    const accountOwnerId = attachAuthOwner({
      snapshot: active,
      ref: activeRef,
      refKey: "file:missing:/active",
      contractDigest: combineSecretOwnerContractDigests([
        digestSecretOwnerContract(
          canonicalizeSecretRefsForOwnerContract(
            {
              profile: authProfile(activeRef),
              providerId: "openai",
              configuredProvider: undefined,
            },
            undefined,
          ),
        ),
      ]),
    });
    activate(active);

    const error = await captureFailure(config);

    expectOwners(
      error,
      { ownerKind: "provider", ownerId: "example" },
      {
        ownerKind: "account",
        ownerId: accountOwnerId,
        degradationState: "stale",
        source: "auth-store",
        failureMatched: true,
      },
    );
  });

  it("includes active web-tool co-owners when strict resolution fails first", async () => {
    const sharedRef = envRef("SHARED_API_KEY");
    const config = asConfig({
      models: models(sharedRef),
      ...webConfig(sharedRef),
    });
    const active = await prepare(config, { env: { SHARED_API_KEY: "dummy" } });
    const authOwnerId = attachAuthOwner({
      snapshot: active,
      ref: sharedRef,
      refKey: "env:default:SHARED_API_KEY",
      append: true,
    });
    activate(active);

    const error = await captureFailure(config, { env: {} });

    expectOwners(
      error,
      { ownerKind: "provider", ownerId: "example" },
      {
        ownerKind: "capability",
        ownerId: "web-search:gemini",
        degradationState: "stale",
        failureMatched: true,
      },
      {
        ownerKind: "account",
        ownerId: authOwnerId,
        source: "auth-store",
        failureMatched: true,
      },
    );
  });

  it.each([true, false])(
    "attributes a shared invalid value to every owner (active: %s)",
    async (active) => {
      if (process.platform === "win32") {
        return;
      }
      const secretsPath = path.join(
        tempDirs.make("openclaw-shared-invalid-secretref-"),
        "secrets.json",
      );
      await writeSharedSecret(secretsPath, active ? "dummy" : { invalid: true });
      const sharedRef = fileRef("shared", "/shared");
      const config = asConfig({
        secrets: sharedSecrets(secretsPath),
        ...(active
          ? webConfig(sharedRef, true)
          : {
              models: models(sharedRef),
              tts: tts(sharedRef),
              skills: { entries: { healthy: { apiKey: envRef("HEALTHY_SKILL_KEY") } } },
            }),
      });
      if (active) {
        await prepareActive(config);
        await fs.writeFile(secretsPath, JSON.stringify({ shared: { invalid: true } }), "utf8");
      }
      const error = await captureFailure(
        config,
        active
          ? {}
          : {
              env: { HEALTHY_SKILL_KEY: "healthy-skill-key" },
              allowUnavailableSecretOwners: true,
            },
      );

      expectOwners(
        error,
        ...(active ? ["web-search:gemini", "web-fetch:firecrawl"] : ["example", "tts"]).map(
          (ownerId) =>
            Object.assign(
              { ownerKind: ownerId === "example" ? "provider" : "capability", ownerId },
              invalidValue,
              active ? { degradationState: "stale" } : {},
            ),
        ),
      );
      if (!active) {
        expect(error).toBeInstanceOf(Error);
        const owners = listSecretResolutionErrorOwners(error);
        expect(owners).toHaveLength(2);
        expect(owners).not.toContainEqual(expect.objectContaining({ ownerId: "skill:healthy" }));
      }
    },
  );

  it("still fails required gateway auth SecretRefs when env is missing", async () => {
    const error = await captureFailure(
      asConfig({
        gateway: { auth: { mode: "token", token: envRef("GATEWAY_TOKEN_REF") } },
      }),
      { env: {}, allowUnavailableSecretOwners: true },
    );

    expect(String(error)).toContain(
      'Environment variable "GATEWAY_TOKEN_REF" is missing or empty.',
    );
    expectOnlyOwner(error, {
      ownerKind: "gateway",
      ownerId: "ingress-auth",
      degradationState: "cold",
      failureMatched: true,
    });
  });
});
