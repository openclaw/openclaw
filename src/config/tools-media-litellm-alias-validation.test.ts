import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("tools.media LiteLLM alias validation", () => {
  it("rejects shared tools.media models that use LiteLLM routing aliases", async () => {
    const res = await validateConfigObject({
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
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "tools.media.models.0.model",
        }),
      ]),
    );
    expect(res.issues.map((issue) => issue.message).join("\n")).toContain(
      "LiteLLM routing aliases are not allowed in tools.media",
    );
  });

  it("rejects capability-specific tools.media models that use LiteLLM routing aliases", async () => {
    const res = await validateConfigObject({
      tools: {
        media: {
          image: {
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
    expect(res.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "tools.media.image.models.0.model",
        }),
      ]),
    );
  });

  it("accepts direct providers and concrete LiteLLM model ids", async () => {
    const direct = await validateConfigObject({
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
    const concreteLiteLLM = await validateConfigObject({
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

    expect(direct.ok).toBe(true);
    expect(concreteLiteLLM.ok).toBe(true);
  });
});
