import { describe, expect, it } from "vitest";
import { INVALID_EXEC_SECRET_REF_IDS } from "../test-utils/secret-ref-test-vectors.js";
import { validateConfigObjectRaw } from "./validation.js";

const provider = (fields: Record<string, unknown>) => ({
  baseUrl: "https://api.openai.com/v1",
  models: [{ id: "gpt-5", name: "gpt-5" }],
  ...fields,
});
const validateProvider = (fields: Record<string, unknown>) =>
  validateConfigObjectRaw({ models: { providers: { openai: provider(fields) } } });
const validateOpenAiApiKeyRef = (apiKey: unknown) => validateProvider({ apiKey });
const validateGithub = (github: Record<string, unknown>) =>
  validateConfigObjectRaw({ tools: { github } });
const secretRef = (source: string, id: string, providerId = "default") => ({
  source,
  provider: providerId,
  id,
});

function expectInvalidApiKey(apiKey: unknown, message: string) {
  const result = validateOpenAiApiKeyRef(apiKey);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(
      result.issues.some(
        (issue) =>
          issue.path.includes("models.providers.openai.apiKey") && issue.message.includes(message),
      ),
    ).toBe(true);
  }
}

describe("config secret refs schema", () => {
  it("accepts top-level secrets sources and model apiKey refs", () => {
    const result = validateConfigObjectRaw({
      secrets: {
        egressProxy: {
          enabled: true,
          allowedHosts: ["api.example.com"],
          bypassHosts: ["pinned.example.com"],
        },
        providers: {
          default: { source: "env" },
          filemain: {
            source: "file",
            path: "~/.openclaw/secrets.json",
            mode: "json",
            timeoutMs: 10_000,
          },
          vault: {
            source: "exec",
            command: "/usr/local/bin/openclaw-secret-resolver",
            args: ["resolve"],
          },
          store: { source: "store" },
        },
        defaults: { store: "store" },
      },
      models: {
        providers: {
          openai: provider({ apiKey: secretRef("env", "OPENAI_API_KEY") }),
          stored: provider({
            baseUrl: "https://stored.example.test/v1",
            apiKey: secretRef("store", "STORED_API_KEY", "store"),
            models: [{ id: "fixture", name: "fixture" }],
          }),
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.secrets?.egressProxy).toEqual({
        enabled: true,
        allowedHosts: ["api.example.com"],
        bypassHosts: ["pinned.example.com"],
      });
    }
  });

  it.each(["allowedHosts", "bypassHosts"])("rejects wildcard secret egress %s", (field) => {
    const result = validateConfigObjectRaw({
      secrets: { egressProxy: { enabled: false, [field]: ["*.example.com"] } },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects store refs outside the env-name grammar", () => {
    expect(validateOpenAiApiKeyRef(secretRef("store", "lowercase")).ok).toBe(false);
  });

  it("accepts a preview SecretRef while keeping GitHub tool identity secret-free", () => {
    expect(
      validateConfigObjectRaw({
        gateway: {
          controlUi: { github: { token: secretRef("store", "CONTROL_UI_GITHUB") } },
        },
        tools: { github: { profileId: "ghp_77777777777777777777777777777777" } },
      }).ok,
    ).toBe(true);

    expect(
      validateGithub({
        profileId: "ghp_88888888888888888888888888888888",
        token: secretRef("store", "AGENT_GITHUB"),
      }).ok,
    ).toBe(false);
    expect(validateGithub({ profileId: "../../native" }).ok).toBe(false);
    expect(validateGithub({}).ok).toBe(false);
  });

  it("rejects model provider request proxy url secret refs", () => {
    const result = validateProvider({
      request: {
        proxy: { mode: "explicit-proxy", url: secretRef("env", "PROVIDER_PROXY_URL") },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path.includes("models.providers.openai.request.proxy")),
      ).toBe(true);
    }
  });

  it.each([
    ["env", "/providers/openai/apiKey", "Env secret reference id"],
    ["file", "providers/openai/apiKey", "absolute JSON pointer"],
  ])("rejects malformed %s references", (source, id, message) => {
    expectInvalidApiKey(secretRef(source, id), message);
  });

  it("rejects invalid exec secret reference ids", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      const result = validateOpenAiApiKeyRef(secretRef("exec", id, "vault"));
      expect(result.ok, `expected invalid exec ref id: ${id}`).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some((issue) => issue.path.includes("models.providers.openai.apiKey")),
        ).toBe(true);
      }
    }
  });
});
