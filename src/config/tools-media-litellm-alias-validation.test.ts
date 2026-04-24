import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("tools.media LiteLLM alias validation", () => {
  it("rejects shared tools.media models that use LiteLLM routing aliases", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "litellm",
              model: "vision",
              capabilities: ["image"],
              type: "provider",
            },
          ],
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected config validation to fail");
    }
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "tools.media.models.0.model",
        }),
      ]),
    );
    expect(res.issues.map((issue) => issue.message).join("\n")).toContain(
      "Invalid media model reference. Use a direct provider/model id instead.",
    );
  });

  it("rejects capability-specific tools.media models that use LiteLLM routing aliases", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          audio: {
            models: [
              {
                provider: "litellm",
                model: "complex",
                type: "provider",
              },
            ],
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected config validation to fail");
    }
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "tools.media.audio.models.0.model",
        }),
      ]),
    );
  });

  it("accepts CLI media entries even when legacy provider/model fields resemble LiteLLM aliases", () => {
    const sharedCli = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              type: "cli",
              command: "echo",
              args: ["ok"],
              provider: "litellm",
              model: "vision",
            },
          ],
        },
      },
    });
    const imageCli = validateConfigObject({
      tools: {
        media: {
          image: {
            models: [
              {
                type: "cli",
                command: "echo",
                args: ["ok"],
                provider: "litellm",
                model: "complex",
              },
            ],
          },
        },
      },
    });

    expect(sharedCli.ok).toBe(true);
    expect(imageCli.ok).toBe(true);
  });

  it("rejects agents.defaults.imageModel aliases when tools.media.image may fall back to them", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          image: {
            enabled: true,
          },
        },
      },
      agents: {
        defaults: {
          imageModel: {
            primary: "litellm/vision",
            fallbacks: ["litellm/complex", "openai/gpt-4o-mini"],
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected config validation to fail");
    }
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents.defaults.imageModel.primary",
        }),
        expect.objectContaining({
          path: "agents.defaults.imageModel.fallbacks.0",
        }),
      ]),
    );
  });

  it("rejects agents.defaults.imageModel aliases when no tools.media config is set", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          imageModel: "litellm/vision",
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected config validation to fail");
    }
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents.defaults.imageModel",
        }),
      ]),
    );
  });

  it("rejects agents.defaults.imageModel aliases when shared media models are non-image only", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "openai",
              model: "gpt-4o-mini-transcribe",
              capabilities: ["audio"],
              type: "provider",
            },
          ],
        },
      },
      agents: {
        defaults: {
          imageModel: {
            primary: "litellm/vision",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected config validation to fail");
    }
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents.defaults.imageModel.primary",
        }),
      ]),
    );
  });

  it("rejects agents.defaults.imageModel aliases when shared LiteLLM media models cannot resolve for image", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "litellm",
              model: "gpt-4o-mini",
              type: "provider",
            },
          ],
        },
      },
      agents: {
        defaults: {
          imageModel: "litellm/vision",
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected config validation to fail");
    }
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents.defaults.imageModel",
        }),
      ]),
    );
  });

  it("rejects agents.defaults.imageModel aliases when explicit image entries cannot resolve for image", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          image: {
            enabled: true,
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                type: "provider",
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          imageModel: "litellm/vision",
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected config validation to fail");
    }
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents.defaults.imageModel",
        }),
      ]),
    );
  });

  it("accepts agents.defaults.imageModel aliases when shared media provider capability is unknown", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "unknown-provider",
              model: "mystery-model",
              type: "provider",
            },
          ],
        },
      },
      agents: {
        defaults: {
          imageModel: {
            primary: "litellm/vision",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agents.defaults.imageModel aliases when shared media providers are plugin-capable but config-only", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "custom-image",
              model: "custom-model",
              type: "provider",
            },
          ],
        },
      },
      models: {
        providers: {
          "custom-image": {
            baseUrl: "https://example.com/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          imageModel: {
            primary: "litellm/vision",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects agents.defaults.imageModel aliases when shared bundled providers are audio-only", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "deepgram",
              model: "nova-3",
              type: "provider",
            },
          ],
        },
      },
      agents: {
        defaults: {
          imageModel: {
            primary: "litellm/vision",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected config validation to fail");
    }
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents.defaults.imageModel.primary",
        }),
      ]),
    );
  });

  it("accepts direct providers and concrete LiteLLM model ids", () => {
    const direct = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "openai",
              model: "gpt-4o-mini",
              capabilities: ["image"],
              type: "provider",
            },
          ],
        },
      },
      agents: { defaults: { imageModel: { primary: "litellm/gpt-4o-mini" } } },
    });
    const concreteLiteLLM = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "litellm",
              model: "gpt-4o-mini",
              capabilities: ["image"],
              type: "provider",
            },
          ],
        },
      },
    });
    const explicitImageModels = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "openai",
              model: "gpt-4o-mini",
              capabilities: ["image"],
              type: "provider",
            },
          ],
        },
      },
      agents: { defaults: { imageModel: { primary: "litellm/vision" } } },
    });
    const inferredSharedImageProvider = validateConfigObject({
      tools: {
        media: {
          models: [
            {
              provider: "openai",
              model: "gpt-4o-mini",
              type: "provider",
            },
          ],
        },
      },
      agents: { defaults: { imageModel: { primary: "litellm/vision" } } },
    });
    expect(direct.ok).toBe(true);
    expect(concreteLiteLLM.ok).toBe(true);
    expect(explicitImageModels.ok).toBe(true);
    expect(inferredSharedImageProvider.ok).toBe(true);
  });
});
