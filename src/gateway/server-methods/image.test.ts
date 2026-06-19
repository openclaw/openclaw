import { describe, it, expect, vi } from "vitest";
import { imageHandlers } from "./image.js";

describe("imageHandlers", () => {
  it("image.providers returns provider list", async () => {
    const mockRespond = vi.fn();
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: {
          defaults: {
            imageGenerationModel: { providers: {} },
          },
        },
      }),
    };

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.any(Array),
      }),
    );
  });
});
