import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildTalkTestProviderConfig,
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";

function runTargetRegistrySnippet<T>(source: string): T {
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.VITEST;
  delete childEnv.VITEST_MODE;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;

  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as T;
}

describe("secret target registry", () => {
  it("supports filtered discovery by target ids", () => {
    const config = {
      ...buildTalkTestProviderConfig({ source: "env", provider: "default", id: "TALK_API_KEY" }),
      gateway: {
        remote: {
          token: { source: "env", provider: "default", id: "REMOTE_TOKEN" },
        },
      },
    };

    const targets = runTargetRegistrySnippet<
      Array<{ entry?: { id?: string }; providerId?: string; path?: string }>
    >(
      `import { discoverConfigSecretTargetsByIds } from "./src/secrets/target-registry.ts";
const config = ${JSON.stringify(config)};
const result = discoverConfigSecretTargetsByIds(config, new Set(["talk.providers.*.apiKey"]));
process.stdout.write(JSON.stringify(result));`,
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]?.entry?.id).toBe("talk.providers.*.apiKey");
    expect(targets[0]?.providerId).toBe(TALK_TEST_PROVIDER_ID);
    expect(targets[0]?.path).toBe(TALK_TEST_PROVIDER_API_KEY_PATH);
  });

  it("resolves config targets by exact path including sibling ref metadata", () => {
    const target = runTargetRegistrySnippet<{
      entry?: { id?: string };
      refPathSegments?: string[];
    } | null>(
      `import { resolveConfigSecretTargetByPath } from "./src/secrets/target-registry.ts";
const result = resolveConfigSecretTargetByPath(["channels", "googlechat", "serviceAccount"]);
process.stdout.write(JSON.stringify(result));`,
    );

    expect(target).not.toBeNull();
    expect(target?.entry?.id).toBe("channels.googlechat.serviceAccount");
    expect(target?.refPathSegments).toEqual(["channels", "googlechat", "serviceAccountRef"]);
  });

  it("returns null when no config target path matches", () => {
    const target = runTargetRegistrySnippet<unknown>(
      `import { resolveConfigSecretTargetByPath } from "./src/secrets/target-registry.ts";
const result = resolveConfigSecretTargetByPath(["gateway", "auth", "mode"]);
process.stdout.write(JSON.stringify(result));`,
    );

    expect(target).toBeNull();
  });
});
