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
  const { getConfigValueAtPath } = await import("./config-paths.js");
  return {
    unsupportedSecretRefSurfacePolicy: {
      collectConfigCandidates: (raw: unknown) =>
        isRecord(raw)
          ? ["hooks.token", "channels.discord.threadBindings.webhookToken"].map((path) => ({
              path,
              value: getConfigValueAtPath(raw, path.split(".")),
            }))
          : [],
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

function redactWarnings(redactPatterns: string[]) {
  const result = validateConfigObjectWithPlugins(
    { logging: { redactPatterns } },
    {
      pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [] } },
    },
  );
  expect(result.ok).toBe(true);
  return result.warnings.filter((warning) => warning.path.startsWith("logging.redactPatterns"));
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
  expect(
    issues.some((issue) => issue.path === "hooks.token" && issue.message.includes(schemaError)),
  ).toBe(false);
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
  const parentIssues = issues.filter((issue) => issue.path === "channels.discord.threadBindings");
  expect(parentIssues).toHaveLength(Number(typo));
  if (typo) {
    const message = parentIssues[0]?.message;
    expect(message).toContain("webhookTokne");
    expect(message).not.toContain("webhookToken");
  }
});

it.each([0, 1, 65_535, 65_536])("enforces the gateway TCP port bound at %s", (port) => {
  const result = validateConfigObjectRaw({ gateway: { port } });
  expect(result.ok).toBe(port > 0 && port < 65_536);
  if (!result.ok) {
    expect(issueMessage(result.issues, "gateway.port")).toContain(port === 0 ? ">=1" : "65535");
  }
});

it("warns for patterns that log redaction silently drops", () => {
  const issues = redactWarnings(["ACME-[0-9]+", "(", String.raw`/(\+?\d+[ -]?)+/`]);
  expect(
    issues.map(({ path, message }) => [path, message.match(/ignored \(([^)]+)\)/)?.[1]]),
  ).toEqual([
    ["logging.redactPatterns.1", "invalid-regex"],
    ["logging.redactPatterns.2", "unsafe-nested-repetition"],
  ]);
  expect(issues.every(({ message }) => message.includes("openclaw config validate"))).toBe(true);
});

it("does not warn for the default string list", () => {
  const defaults = getDefaultRedactPatterns().filter(
    (pattern): pattern is string => typeof pattern === "string",
  );
  expect(defaults.length).toBeGreaterThan(0);
  expect(redactWarnings(defaults)).toEqual([]);
});
