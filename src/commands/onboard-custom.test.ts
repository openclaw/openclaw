import { describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { promptCustomApiConfig } from "./onboard-custom.js";

// Mock dependencies
vi.mock("./model-picker.js", () => ({
  applyPrimaryModel: vi.fn((cfg) => cfg),
}));

describe("promptCustomApiConfig", () => {
  it("should handle happy path with smart discovery", async () => {
    // Mock Prompter
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:11434/v1") // Base URL
        .mockResolvedValueOnce(""), // API Key (empty)
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
      select: vi.fn().mockResolvedValue("llama3"), // Select model
      confirm: vi.fn(), // Should not be called in happy path
    };

    // Mock Fetch
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        // Discovery
        ok: true,
        json: async () => ({ data: [{ id: "llama3" }, { id: "mistral" }] }),
      })
      .mockResolvedValueOnce({
        // Verification
        ok: true,
        json: async () => ({}),
      });

    await promptCustomApiConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prompter: prompter as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime: { ...defaultRuntime, log: vi.fn() } as any,
      config: {},
    });

    expect(prompter.text).toHaveBeenCalledTimes(2);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          { value: "llama3", label: "llama3" },
          { value: "__manual", label: "(Enter manually...)" },
        ]),
      }),
    );
  });

  it("should fallback to manual entry when discovery fails", async () => {
    // Mock Prompter
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:11434/v1") // Base URL
        .mockResolvedValueOnce("") // API Key
        .mockResolvedValueOnce("manual-model-id"), // Fallback manual input
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
      select: vi.fn(), // Should not be called
      confirm: vi.fn().mockResolvedValue(true), // Verify fail confirm
    };

    // Mock Fetch (Discovery fails, Verification fails)
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error")) // Discovery fails
      .mockRejectedValueOnce(new Error("Network error")); // Verification fails

    await promptCustomApiConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prompter: prompter as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime: { ...defaultRuntime, log: vi.fn() } as any,
      config: {},
    });

    expect(prompter.text).toHaveBeenCalledTimes(3); // BaseURL, Key, Manual Model ID
    expect(prompter.confirm).toHaveBeenCalled();
  });
});
