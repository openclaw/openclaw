import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const EXEC_FIXTURE_TIMEOUT_MS = 20_000;

async function writeProvider(root: string, name = "provider", body = "exit 1\n") {
  const command = path.join(root, name + ".sh");
  await fs.writeFile(command, "#!/bin/sh\n" + body, { encoding: "utf8", mode: 0o700 });
  return {
    source: "exec" as const,
    command,
    passEnv: ["PATH"],
    timeoutMs: EXEC_FIXTURE_TIMEOUT_MS,
    noOutputTimeoutMs: EXEC_FIXTURE_TIMEOUT_MS,
  };
}

function prepareFailure(
  providers: Record<string, Awaited<ReturnType<typeof writeProvider>>>,
  config: Record<string, unknown>,
) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ ...config, secrets: { providers } }),
    env: { PATH: process.env.PATH ?? "" },
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map(),
  });
}

function modelConfig(
  apiKey: unknown,
  headers?: Record<string, unknown>,
  provider = "example",
  baseUrl?: string,
) {
  return { models: { providers: { [provider]: { apiKey, headers, models: [], baseUrl } } } };
}

describe("provider-scoped SecretRef failure fan-out", () => {
  it("preserves provider provenance for an unavailable web-search owner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-web-secret-provider-failure-");
    const vault = await writeProvider(root);
    const ref = { source: "exec" as const, provider: "vault", id: "web/gemini" };

    const snapshot = await prepareFailure(
      { vault },
      {
        tools: { web: { search: { provider: "gemini" } } },
        plugins: {
          entries: {
            google: { config: { webSearch: { apiKey: ref } } },
          },
        },
      },
    );

    expect(snapshot.degradedOwners).toContainEqual(
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "web-search:gemini",
        reason: "secret provider failed",
        providerFailures: [{ source: "exec", provider: "vault" }],
      }),
    );
  });

  it("reuses one provider failure across isolated owners", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-owner-secret-provider-failure-");
    const callLogPath = path.join(root, "calls.log");
    const shared = await writeProvider(
      root,
      "provider",
      `printf 'call\\n' >> ${JSON.stringify(callLogPath)}\nexit 1\n`,
    );
    const modelRef = { source: "exec" as const, provider: "shared", id: "models/openai" };
    const ttsRef = { source: "exec" as const, provider: "shared", id: "tts/elevenlabs" };

    const snapshot = await prepareFailure(
      { shared },
      {
        ...modelConfig(modelRef, undefined, "openai", "https://api.openai.com/v1"),
        tts: { providers: { elevenlabs: { apiKey: ttsRef } } },
      },
    );

    expect(snapshot.config.models?.providers?.openai?.apiKey).toEqual(modelRef);
    expect(snapshot.config.tts?.providers?.elevenlabs?.apiKey).toEqual(ttsRef);
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "openai",
        reason: "secret provider failed",
        providerFailures: [{ source: "exec", provider: "shared" }],
      },
      {
        ownerKind: "capability",
        ownerId: "tts",
        reason: "secret provider failed",
        providerFailures: [{ source: "exec", provider: "shared" }],
      },
    ]);
    expect((await fs.readFile(callLogPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("records every failed provider used by one isolated owner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-owner-multi-provider-failure-");
    const first = await writeProvider(root, "first");
    const second = await writeProvider(root, "second");

    const snapshot = await prepareFailure(
      { first, second },
      modelConfig(
        { source: "exec", provider: "first", id: "api-key" },
        { "X-Secondary": { source: "exec", provider: "second", id: "secondary" } },
      ),
    );

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "example",
        providerFailures: [
          { source: "exec", provider: "first" },
          { source: "exec", provider: "second" },
        ],
      },
    ]);
  });

  it("retains a ref failure when the same owner also has a provider outage", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-owner-mixed-provider-failure-");
    const unavailable = await writeProvider(root);
    const refResponse = JSON.stringify({
      protocolVersion: 1,
      values: {},
      errors: { secondary: { code: "NOT_FOUND" } },
    });
    const partial = await writeProvider(
      root,
      "ref",
      `printf '%s\\n' ${JSON.stringify(refResponse)}\n`,
    );

    const snapshot = await prepareFailure(
      { unavailable, partial },
      modelConfig(
        { source: "exec", provider: "unavailable", id: "api-key" },
        { "X-Secondary": { source: "exec", provider: "partial", id: "secondary" } },
      ),
    );

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "example",
        reason: "secret reference was not found",
        providerFailures: [{ source: "exec", provider: "unavailable" }],
        refFailureReason: "secret reference was not found",
      },
    ]);
  });
});
