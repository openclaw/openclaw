import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config secret refs schema", () => {
  it("accepts top-level secrets sources and model apiKey refs", () => {
    const result = validateConfigObjectRaw({
      secrets: {
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
            allowSymlinkCommand: true,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts openai-codex-responses as a model api value", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [{ id: "gpt-5.3-codex", name: "gpt-5.3-codex" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts googlechat serviceAccount refs", () => {
    const result = validateConfigObjectRaw({
      channels: {
        googlechat: {
          serviceAccountRef: {
            source: "file",
            provider: "filemain",
            id: "/channels/googlechat/serviceAccount",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts skills entry apiKey refs", () => {
    const result = validateConfigObjectRaw({
      skills: {
        entries: {
          "review-pr": {
            enabled: true,
            apiKey: { source: "env", provider: "default", id: "SKILL_REVIEW_PR_API_KEY" },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it('accepts file refs with id "value" for singleValue mode providers', () => {
    const result = validateConfigObjectRaw({
      secrets: {
        providers: {
          rawfile: {
            source: "file",
            path: "~/.openclaw/token.txt",
            mode: "singleValue",
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "file", provider: "rawfile", id: "value" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid secret ref id", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "bad id with spaces" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path.includes("models.providers.openai.apiKey")),
      ).toBe(true);
    }
  });

  it("rejects env refs that are not env var names", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "/providers/openai/apiKey" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
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
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "file", provider: "default", id: "providers/openai/apiKey" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
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
});
