import { describe, expect, it } from "vitest";
import { INVALID_EXEC_SECRET_REF_IDS } from "../test-utils/secret-ref-test-vectors.js";
import { validateConfigObjectRaw } from "./validation.js";

function validateOpenAiApiKeyRef(apiKey: unknown) {
  return validateConfigObjectRaw({
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey,
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    },
  });
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
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
          stored: {
            baseUrl: "https://stored.example.test/v1",
            apiKey: { source: "store", provider: "store", id: "STORED_API_KEY" },
            models: [{ id: "fixture", name: "fixture" }],
          },
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

  it.each([
    { field: "allowedHosts", host: "*.example.com" },
    { field: "bypassHosts", host: "*.example.com" },
  ])("rejects invalid secret egress $field entry $host", ({ field, host }) => {
    const result = validateConfigObjectRaw({
      secrets: { egressProxy: { enabled: false, [field]: [host] } },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects store refs outside the env-name grammar", () => {
    expect(
      validateOpenAiApiKeyRef({ source: "store", provider: "default", id: "lowercase" }).ok,
    ).toBe(false);
  });

  it("accepts a preview SecretRef while keeping GitHub tool identity secret-free", () => {
    expect(
      validateConfigObjectRaw({
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "CONTROL_UI_GITHUB" },
            },
          },
        },
        tools: {
          github: {
            profileId: "ghp_77777777777777777777777777777777",
          },
        },
      }).ok,
    ).toBe(true);

    expect(
      validateConfigObjectRaw({
        tools: {
          github: {
            profileId: "ghp_88888888888888888888888888888888",
            token: { source: "store", provider: "default", id: "AGENT_GITHUB" },
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateConfigObjectRaw({
        tools: { github: { profileId: "../../native" } },
      }).ok,
    ).toBe(false);
    expect(validateConfigObjectRaw({ tools: { github: {} } }).ok).toBe(false);
  });

  it("rejects model provider request proxy url secret refs", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            request: {
              proxy: {
                mode: "explicit-proxy",
                url: { source: "env", provider: "default", id: "PROVIDER_PROXY_URL" },
              },
            },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path.includes("models.providers.openai.request.proxy")),
      ).toBe(true);
    }
  });

  it("rejects env refs that are not env var names", () => {
    const result = validateOpenAiApiKeyRef({
      source: "env",
      provider: "default",
      id: "/providers/openai/apiKey",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            issue.path.includes("models.providers.openai.apiKey") &&
            issue.message.includes("Env secret reference id"),
        ),
      ).toBe(true);
    }
  });

  it("rejects file refs that are not absolute JSON pointers", () => {
    const result = validateOpenAiApiKeyRef({
      source: "file",
      provider: "default",
      id: "providers/openai/apiKey",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            issue.path.includes("models.providers.openai.apiKey") &&
            issue.message.includes("absolute JSON pointer"),
        ),
      ).toBe(true);
    }
  });

  it("rejects invalid exec secret reference ids", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      const result = validateOpenAiApiKeyRef({
        source: "exec",
        provider: "vault",
        id,
      });
      expect(result.ok, `expected invalid exec ref id: ${id}`).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some((issue) => issue.path.includes("models.providers.openai.apiKey")),
        ).toBe(true);
      }
    }
  });
});
