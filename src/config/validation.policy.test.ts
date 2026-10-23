import { expect, it, vi } from "vitest";
import { getDefaultRedactPatterns } from "../logging/redact.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
import { validationIssues as requireIssues } from "./validation.test-helpers.js";

// mock-isolation: Supply fixed unsupported surfaces without loading plugin policy discovery.
vi.mock("../secrets/unsupported-surface-policy.js", async () => {
  const { isRecord } = await import("../utils.js");

  return {
    unsupportedSecretRefSurfacePolicy: {
      collectConfigCandidates: (raw: unknown) =>
        Object.entries({
          hooks: "token",
          "channels.discord.threadBindings": "webhookToken",
        }).flatMap(([parentPath, key]) => {
          const parent = parentPath
            .split(".")
            .reduce<unknown>(
              (value, segment) => (isRecord(value) ? value[segment] : undefined),
              raw,
            );
          return isRecord(parent) ? [{ path: `${parentPath}.${key}`, value: parent[key] }] : [];
        }),
    },
  };
});

const issueMessage = (issues: ReturnType<typeof requireIssues>, path: string) =>
  issues.find((entry) => entry.path === path)?.message;
const invalid = (raw: unknown) => requireIssues(validateConfigObjectRaw(raw));
const secretRef = (id: string, source = "env", provider = "default") => ({ source, provider, id });
const schemaError = "Invalid input: expected string, received object";
const webhookPath = "channels.discord.threadBindings.webhookToken";

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

function validateCredential(source: "env" | "exec", defaultAlias = false) {
  return validateConfigObjectRawWithPlugins(
    {
      plugins: {
        entries: {
          "secret-fixture": {
            enabled: false,
            config: { credential: secretRef("PLUGIN_PRIVATE_CREDENTIAL", source, "shared") },
          },
        },
      },
      secrets: {
        defaults: defaultAlias ? { [source]: "shared" } : undefined,
        providers: { shared: { source: "file", path: "/tmp/unused-secrets.json", mode: "json" } },
      },
    },
    {
      semanticValidation: "strict",
      pluginMetadataSnapshot: {
        manifestRegistry: { diagnostics: [], plugins: [secretFixturePlugin] },
      },
    },
  );
}

it("rejects impossible inactive plugin SecretRefs in strict mode without leaking their IDs", () => {
  const issues = requireIssues(validateCredential("exec"));
  expect(issueMessage(issues, "plugins.entries.secret-fixture.config.credential")).toContain(
    'Secret provider "shared" has source "file" but ref requests "exec"',
  );
  expect(JSON.stringify(issues)).not.toContain("PLUGIN_PRIVATE_CREDENTIAL");
});

it("allows a built-in default alias to shadow another-source provider", () => {
  expect(validateCredential("env", true).ok).toBe(true);
});

it("replaces hooks.token schema errors with SecretRef policy guidance", () => {
  const issues = invalid({ hooks: { token: secretRef("HOOK_TOKEN") } });
  const message = issueMessage(issues, "hooks.token");
  expect(message).toContain("SecretRef objects are not supported at hooks.token");
  expect(message).toContain("https://docs.openclaw.ai/reference/secretref-credential-surface");
  expect(issues).not.toContainEqual(
    expect.objectContaining({
      path: "hooks.token",
      message: expect.stringContaining(schemaError),
    }),
  );
});

it("keeps standard schema errors for non-SecretRef objects", () => {
  expect(issueMessage(invalid({ hooks: { token: { unexpected: "value" } } }), "hooks.token")).toBe(
    schemaError,
  );
});

it("allows env-template strings on mutable paths", () => {
  expect(validateConfigObjectRaw({ hooks: { token: "${HOOK_TOKEN}" } }).ok).toBe(true);
});

it.each([false, true])("filters only the policy-owned unknown key (typo=%s)", (typo) => {
  const issues = invalid({
    channels: {
      discord: {
        threadBindings: {
          webhookToken: secretRef("DISCORD_THREAD_BINDING_WEBHOOK_TOKEN"),
          ...(typo ? { webhookTokne: "typo" } : {}),
        },
      },
    },
  });
  expect(issueMessage(issues, webhookPath)).toContain(
    `SecretRef objects are not supported at ${webhookPath}`,
  );
  if (typo) {
    const message = issueMessage(issues, "channels.discord.threadBindings");
    expect(message).toContain("webhookTokne");
    expect(message).not.toContain("webhookToken");
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

it("enforces the gateway TCP port range", () => {
  for (const port of [0, 65_536]) {
    const message = issueMessage(invalid({ gateway: { port } }), "gateway.port");
    if (port === 0) {
      expect(message).toContain("expected number to be >=1");
    } else {
      expect(message).toBeDefined();
    }
  }
  for (const port of [1, 65_535]) {
    expect(validateConfigObjectRaw({ gateway: { port } }).ok).toBe(true);
  }
});

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
