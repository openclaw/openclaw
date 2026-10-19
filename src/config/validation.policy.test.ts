import { describe, expect, it, vi } from "vitest";
import { getDefaultRedactPatterns } from "../logging/redact.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

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

function requireIssues(result: ReturnType<typeof validateConfigObjectRaw>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected invalid config");
  }
  return result.issues;
}

function requireIssue(issues: ReturnType<typeof requireIssues>, path: string) {
  const issue = issues.find((entry) => entry.path === path);
  if (!issue) {
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

const secretFixturePlugin = createPluginManifestRecordFixture({
  id: "secret-fixture",
  configContracts: {
    secretInputs: { paths: [{ path: "credential", expected: "string" }] },
  },
  configSchema: { type: "object", additionalProperties: true },
});

function warnings(config: unknown, prefix: string) {
  const result = validateConfigObjectWithPlugins(config, {
    pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [] } },
  });
  expect(result.ok).toBe(true);
  return result.warnings.filter((warning) => warning.path.startsWith(prefix));
}

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
  it("rejects impossible inactive plugin SecretRefs in strict mode without leaking their IDs", () => {
    const issues = requireIssues(validateCredential("exec", true));
    expect(
      requireIssue(issues, "plugins.entries.secret-fixture.config.credential").message,
    ).toContain('Secret provider "shared" has source "file" but ref requests "exec"');
    expect(JSON.stringify(issues)).not.toContain("PLUGIN_PRIVATE_CREDENTIAL");
  });

  it("allows a built-in default alias to shadow another-source provider", () => {
    expect(validateCredential("env", true, true).ok).toBe(true);
  });

  it("replaces hooks.token schema errors with SecretRef policy guidance", () => {
    const issues = requireIssues(
      validateConfigObjectRaw({
        hooks: { token: { source: "env", provider: "default", id: "HOOK_TOKEN" } },
      }),
    );
    const issue = requireIssue(issues, "hooks.token");
    expect(issue.message).toContain("SecretRef objects are not supported at hooks.token");
    expect(issue.message).toContain(
      "https://docs.openclaw.ai/reference/secretref-credential-surface",
    );
    expect(
      issues.some(
        (entry) =>
          entry.path === "hooks.token" &&
          entry.message.includes("Invalid input: expected string, received object"),
      ),
    ).toBe(false);
  });

  it("keeps standard schema errors for non-SecretRef objects", () => {
    const issues = requireIssues(
      validateConfigObjectRaw({ hooks: { token: { unexpected: "value" } } }),
    );
    expect(requireIssue(issues, "hooks.token").message).toBe(
      "Invalid input: expected string, received object",
    );
  });

  it("allows env-template strings on mutable paths", () => {
    expect(validateConfigObjectRaw({ hooks: { token: "${HOOK_TOKEN}" } }).ok).toBe(true);
  });

  it.each([false, true])("filters only the policy-owned unknown key (typo=%s)", (typo) => {
    const issues = requireIssues(
      validateConfigObjectRaw({
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
      }),
    );
    expect(requireIssue(issues, "channels.discord.threadBindings.webhookToken").message).toContain(
      "SecretRef objects are not supported at channels.discord.threadBindings.webhookToken",
    );
    if (typo) {
      const issue = requireIssue(issues, "channels.discord.threadBindings");
      expect(issue.message).toContain("webhookTokne");
      expect(issue.message).not.toContain("webhookToken");
    } else {
      expect(
        issues.some(
          (issue) =>
            issue.path === "channels.discord.threadBindings" &&
            issue.message.includes('Unrecognized key: "webhookToken"'),
        ),
      ).toBe(false);
    }
  });
});

it("enforces the gateway TCP port range", () => {
  for (const port of [0, 65_536]) {
    const issue = requireIssue(
      requireIssues(validateConfigObjectRaw({ gateway: { port } })),
      "gateway.port",
    );
    if (port === 0) {
      expect(issue.message).toContain("expected number to be >=1");
    } else {
      expect(issue.message).toBeDefined();
    }
  }
  for (const port of [1, 65_535]) {
    expect(validateConfigObjectRaw({ gateway: { port } }).ok).toBe(true);
  }
});

describe("ambient heartbeat ownership", () => {
  const heartbeatWarnings = (agents: unknown) =>
    warnings({ agents }, "agents.defaults.heartbeat.agentId");

  it("warns that an ownerless explicit multi-agent roster keeps heartbeats disabled", () => {
    expect(heartbeatWarnings({ ownership: "explicit", entries: { main: {}, ops: {} } })).toEqual([
      {
        path: "agents.defaults.heartbeat.agentId",
        message:
          "Multi-agent config has no ambient heartbeat owner; heartbeats stay disabled until agents.defaults.heartbeat.agentId or agents.defaults.systemAgent.agentId is set.",
      },
    ]);
  });

  it.each([
    {
      name: "per-agent heartbeat",
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
      },
    },
    {
      name: "broadcast heartbeat",
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {} },
        defaults: { heartbeat: { every: "30m" } },
      },
    },
  ])("does not warn for a $name", ({ agents }) => {
    expect(heartbeatWarnings(agents)).toEqual([]);
  });
});

describe("logging.redactPatterns", () => {
  const redactWarnings = (redactPatterns: string[]) =>
    warnings({ logging: { redactPatterns } }, "logging.redactPatterns");

  it("warns for patterns that log redaction silently drops", () => {
    expect(redactWarnings(["ACME-[0-9]+", "(", String.raw`/(\+?\d+[ -]?)+/`])).toEqual([
      {
        path: "logging.redactPatterns.1",
        message:
          "Redaction pattern is ignored (invalid-regex); values it should mask stay visible in logs and diagnostics. Fix the regex syntax, then run openclaw config validate again.",
      },
      {
        path: "logging.redactPatterns.2",
        message:
          "Redaction pattern is ignored (unsafe-nested-repetition); values it should mask stay visible in logs and diagnostics. Rewrite the nested repetition, for example (a+)+ as a+, then run openclaw config validate again.",
      },
    ]);
  });

  it("does not warn for the default string list", () => {
    const defaults = getDefaultRedactPatterns().filter(
      (pattern): pattern is string => typeof pattern === "string",
    );
    expect(defaults.length).toBeGreaterThan(0);
    expect(redactWarnings(defaults)).toEqual([]);
  });
});
