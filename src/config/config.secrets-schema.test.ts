import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config secret refs schema", () => {
  it("accepts top-level secrets sources and model apiKey refs", () => {
    const result = validateConfigObjectRaw({
      secrets: {
        sources: {
          env: { type: "env" },
          file: { type: "sops", path: "~/.openclaw/secrets.enc.json", timeoutMs: 10_000 },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", id: "OPENAI_API_KEY" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
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
          serviceAccountRef: { source: "file", id: "/channels/googlechat/serviceAccount" },
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
            apiKey: { source: "env", id: "SKILL_REVIEW_PR_API_KEY" },
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
            apiKey: { source: "env", id: "bad id with spaces" },
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
            apiKey: { source: "env", id: "/providers/openai/apiKey" },
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
            apiKey: { source: "file", id: "providers/openai/apiKey" },
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
