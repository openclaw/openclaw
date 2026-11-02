import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const EXEC_FIXTURE_TIMEOUT_MS = 20_000;
const execRef = (provider: string, id: string) => ({ source: "exec" as const, provider, id });
function failedOwner(ownerKind: string, ownerId: string, ...providers: string[]) {
  return {
    ownerKind,
    ownerId,
    reason: "secret provider failed",
    providerFailures: providers.map((provider) => ({ source: "exec", provider })),
  };
}

async function writeProvider(root: string, name: string, body = "exit 1\n") {
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

it("fans out shared outages while retaining every provider and reference failure", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = tempDirs.make("openclaw-provider-failure-");
  const callLogPath = path.join(root, "calls.log");
  const shared = await writeProvider(
    root,
    "provider",
    `printf 'call\\n' >> ${JSON.stringify(callLogPath)}\nexit 1\n`,
  );
  const modelRef = execRef("shared", "models/openai");
  const ttsRef = execRef("shared", "tts/elevenlabs");
  const second = await writeProvider(root, "second");
  const vault = await writeProvider(root, "vault");
  const response = JSON.stringify({
    protocolVersion: 1,
    values: {},
    errors: { secondary: { code: "NOT_FOUND" } },
  });
  const partial = await writeProvider(
    root,
    "partial",
    `printf '%s\\n' ${JSON.stringify(response)}\n`,
  );

  const snapshot = await prepareSecretsRuntimeSnapshot({
    env: { PATH: process.env.PATH ?? "" },
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map(),
    config: asConfig({
      secrets: { providers: { shared, second, partial, vault } },
      models: {
        providers: {
          openai: {
            apiKey: modelRef,
            models: [],
            baseUrl: "https://api.openai.com/v1",
            headers: {
              "X-Outage": execRef("second", "api-key"),
              "X-Missing": execRef("partial", "secondary"),
            },
          },
        },
      },
      tts: { providers: { elevenlabs: { apiKey: ttsRef } } },
      tools: { web: { search: { provider: "gemini" } } },
      plugins: {
        entries: {
          google: { config: { webSearch: { apiKey: execRef("vault", "web/gemini") } } },
        },
      },
    }),
  });

  expect(snapshot.config.models?.providers?.openai?.apiKey).toEqual(modelRef);
  expect(snapshot.config.tts?.providers?.elevenlabs?.apiKey).toEqual(ttsRef);
  expect(snapshot.degradedOwners).toHaveLength(3);
  expect(snapshot.degradedOwners).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ...failedOwner("provider", "openai", "shared", "second"),
        reason: "secret reference was not found",
        refFailureReason: "secret reference was not found",
      }),
      expect.objectContaining(failedOwner("capability", "tts", "shared")),
      expect.objectContaining(failedOwner("capability", "web-search:gemini", "vault")),
    ]),
  );
  expect((await fs.readFile(callLogPath, "utf8")).trim().split("\n")).toHaveLength(1);
});
