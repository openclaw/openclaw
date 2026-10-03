import { describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { validateConfigObjectRaw, validateConfigObjectRawWithPlugins } from "./validation.js";

vi.mock("../secrets/unsupported-surface-policy.js", async () => {
  const { isRecord } = await import("../utils.js");

  return {
    unsupportedSecretRefSurfacePolicy: {
      collectConfigCandidates: (raw: unknown) => {
        if (!isRecord(raw)) {
          return [];
        }
        const candidates: Array<{ path: string; value: unknown }> = [];

        const hooks = isRecord(raw.hooks) ? raw.hooks : null;
        if (hooks) {
          candidates.push({ path: "hooks.token", value: hooks.token });
        }

        const channels = isRecord(raw.channels) ? raw.channels : null;
        const discord = channels && isRecord(channels.discord) ? channels.discord : null;
        const threadBindings =
          discord && isRecord(discord.threadBindings) ? discord.threadBindings : null;
        if (threadBindings) {
          candidates.push({
            path: "channels.discord.threadBindings.webhookToken",
            value: threadBindings.webhookToken,
          });
        }

        return candidates;
      },
    },
  };
});

function requireIssue<T extends { path: string }>(issues: T[], path: string): T {
  const issue = issues.find((entry) => entry.path === path);
  if (!issue) {
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

const secretFixturePlugin: PluginManifestRecord = {
  id: "secret-fixture",
  channels: [],
  cliBackends: [],
  configContracts: {
    secretInputs: { paths: [{ path: "credential", expected: "string" }] },
  },
  configSchema: { type: "object", additionalProperties: true },
  hooks: [],
  manifestPath: "/tmp/secret-fixture/openclaw.plugin.json",
  origin: "bundled",
  providers: [],
  rootDir: "/tmp/secret-fixture",
  skills: [],
  source: "/tmp/secret-fixture/index.js",
};

function validateCredential(source: "env" | "exec", strict: boolean, defaultAlias = false) {
  return validateConfigObjectRawWithPlugins(
    {
      plugins: {
        entries: {
          "secret-fixture": {
            enabled: false,
            config: { credential: { source, provider: "shared", id: "PLUGIN_PRIVATE_CREDENTIAL" } },
          },
        },
      },
      secrets: {
        defaults: defaultAlias ? { [source]: "shared" } : undefined,
        providers: { shared: { source: "file", path: "/tmp/unused-secrets.json", mode: "json" } },
      },
    },
    {
      semanticValidation: strict ? "strict" : undefined,
      pluginMetadataSnapshot: {
        manifestRegistry: { diagnostics: [], plugins: [secretFixturePlugin] },
      },
    },
  );
}

describe("config validation SecretRef policy", () => {
  it("allows impossible SecretRefs on inactive plugin targets at runtime", () => {
    expect(validateCredential("exec", false).ok).toBe(true);
  });

  it("rejects impossible inactive plugin SecretRefs in strict mode without leaking their IDs", () => {
    const result = validateCredential("exec", true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        requireIssue(result.issues, "plugins.entries.secret-fixture.config.credential").message,
      ).toContain('Secret provider "shared" has source "file" but ref requests "exec"');
      expect(JSON.stringify(result.issues)).not.toContain("PLUGIN_PRIVATE_CREDENTIAL");
    }
  });

  it("allows a built-in default alias to shadow another-source provider", () => {
    expect(validateCredential("env", true, true).ok).toBe(true);
  });

  it("replaces hooks.token schema errors with SecretRef policy guidance", () => {
    const result = validateConfigObjectRaw({
      hooks: { token: { source: "env", provider: "default", id: "HOOK_TOKEN" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "hooks.token");
      expect(issue.message).toContain("SecretRef objects are not supported at hooks.token");
      expect(issue.message).toContain(
        "https://docs.openclaw.ai/reference/secretref-credential-surface",
      );
      expect(
        result.issues.some(
          (entry) =>
            entry.path === "hooks.token" &&
            entry.message.includes("Invalid input: expected string, received object"),
        ),
      ).toBe(false);
    }
  });

  it("keeps standard schema errors for non-SecretRef objects", () => {
    const result = validateConfigObjectRaw({ hooks: { token: { unexpected: "value" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(requireIssue(result.issues, "hooks.token").message).toBe(
        "Invalid input: expected string, received object",
      );
    }
  });

  it("allows env-template strings on mutable paths", () => {
    expect(validateConfigObjectRaw({ hooks: { token: "${HOOK_TOKEN}" } }).ok).toBe(true);
  });

  it.each([false, true])("filters only the policy-owned unknown key (typo=%s)", (typo) => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
          threadBindings: {
            webhookToken: {
              source: "env",
              provider: "default",
              id: "DISCORD_THREAD_BINDING_WEBHOOK_TOKEN",
            },
            ...(typo ? { webhookTokne: "typo" } : {}),
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        requireIssue(result.issues, "channels.discord.threadBindings.webhookToken").message,
      ).toContain(
        "SecretRef objects are not supported at channels.discord.threadBindings.webhookToken",
      );
      if (typo) {
        const issue = requireIssue(result.issues, "channels.discord.threadBindings");
        expect(issue.message).toContain("webhookTokne");
        expect(issue.message).not.toContain("webhookToken");
      } else {
        expect(
          result.issues.some(
            (issue) =>
              issue.path === "channels.discord.threadBindings" &&
              issue.message.includes('Unrecognized key: "webhookToken"'),
          ),
        ).toBe(false);
      }
    }
  });
});

it("enforces the gateway TCP port range", () => {
  for (const port of [0, 65_536]) {
    const result = validateConfigObjectRaw({ gateway: { port } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = requireIssue(result.issues, "gateway.port");
      if (port === 0) {
        expect(issue.message).toContain("expected number to be >=1");
      } else {
        expect(issue.message).toBeDefined();
      }
    }
  }
  for (const port of [1, 65_535]) {
    expect(validateConfigObjectRaw({ gateway: { port } }).ok).toBe(true);
  }
});
