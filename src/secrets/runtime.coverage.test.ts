import { afterEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import { clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } from "./runtime.js";
import { listSecretTargetRegistryEntries } from "./target-registry.js";

type SecretRegistryEntry = ReturnType<typeof listSecretTargetRegistryEntries>[number];

function toConcretePathSegments(pathPattern: string): string[] {
  const segments = pathPattern.split(".").filter(Boolean);
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "*") {
      out.push("sample");
      continue;
    }
    if (segment.endsWith("[]")) {
      out.push(segment.slice(0, -2), "0");
      continue;
    }
    out.push(segment);
  }
  return out;
}

function buildConfigForOpenClawTarget(entry: SecretRegistryEntry, envId: string): OpenClawConfig {
  const config = {} as OpenClawConfig;
  const refTargetPath =
    entry.secretShape === "sibling_ref" && entry.refPathPattern
      ? entry.refPathPattern
      : entry.pathPattern;
  setPathCreateStrict(config, toConcretePathSegments(refTargetPath), {
    source: "env",
    provider: "default",
    id: envId,
  });
  if (entry.id === "gateway.auth.password") {
    setPathCreateStrict(config, ["gateway", "auth", "mode"], "password");
  }
  return config;
}

function buildAuthStoreForTarget(entry: SecretRegistryEntry, envId: string): AuthProfileStore {
  if (entry.authProfileType === "token") {
    return {
      version: 1 as const,
      profiles: {
        sample: {
          type: "token" as const,
          provider: "sample-provider",
          token: "legacy-token",
          tokenRef: {
            source: "env" as const,
            provider: "default",
            id: envId,
          },
        },
      },
    };
  }
  return {
    version: 1 as const,
    profiles: {
      sample: {
        type: "api_key" as const,
        provider: "sample-provider",
        key: "legacy-key",
        keyRef: {
          source: "env" as const,
          provider: "default",
          id: envId,
        },
      },
    },
  };
}

describe("secrets runtime target coverage", () => {
  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("handles every openclaw.json registry target when configured as active", async () => {
    const entries = listSecretTargetRegistryEntries().filter(
      (entry) => entry.configFile === "openclaw.json",
    );
    for (const [index, entry] of entries.entries()) {
      const envId = `OPENCLAW_SECRET_TARGET_${index}`;
      const expectedValue = `resolved-${entry.id}`;
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: buildConfigForOpenClawTarget(entry, envId),
        env: { [envId]: expectedValue },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });
      const resolved = getPath(snapshot.config, toConcretePathSegments(entry.pathPattern));
      if (entry.expectedResolvedValue === "string") {
        expect(resolved).toBe(expectedValue);
      } else {
        expect(typeof resolved === "string" || (resolved && typeof resolved === "object")).toBe(
          true,
        );
      }
    }
  });

  it("handles every auth-profiles registry target", async () => {
    const entries = listSecretTargetRegistryEntries().filter(
      (entry) => entry.configFile === "auth-profiles.json",
    );
    for (const [index, entry] of entries.entries()) {
      const envId = `OPENCLAW_AUTH_SECRET_TARGET_${index}`;
      const expectedValue = `resolved-${entry.id}`;
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {} as OpenClawConfig,
        env: { [envId]: expectedValue },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => buildAuthStoreForTarget(entry, envId),
      });
      const store = snapshot.authStores[0]?.store;
      expect(store).toBeDefined();
      const resolved = getPath(store, toConcretePathSegments(entry.pathPattern));
      expect(resolved).toBe(expectedValue);
    }
  });
});
