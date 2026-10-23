import { expect, it, type Mock } from "vitest";
import { runCapability } from "./capability-cli.test-harness.js";

export function registerEmbeddingCapabilityCliTests({
  embedBatch,
  closeProvider,
  providerCall,
  jsonOutput,
  log,
  expectError,
}: {
  embedBatch: Mock<(inputs: unknown[], options?: { inputType?: string }) => Promise<number[][]>>;
  closeProvider: Mock<() => Promise<void>>;
  providerCall: () => unknown;
  jsonOutput: () => unknown;
  log: Mock;
  expectError: (message: string) => void;
}): void {
  const create = (...args: string[]) =>
    runCapability("embedding", "create", "--text", "hello", ...args);

  it.each([
    { provider: "openai", model: "text-embedding-3-large", explicit: false },
    { provider: "deepinfra", model: "Qwen/Qwen3-Embedding-8B", explicit: true },
  ])(
    "creates embeddings with $provider selection and preserves the model id",
    async ({ provider, model, explicit }) => {
      await create(
        "--text",
        "world",
        "--model",
        `${provider}/${model}`,
        ...(explicit ? ["--provider", provider] : []),
        "--json",
      );
      expect(providerCall()).toMatchObject({ provider, model, fallback: "none" });
      expect(jsonOutput()).toMatchObject({
        capability: "embedding.create",
        provider: "openai",
        model: "text-embedding-3-small",
        outputs: ["hello", "world"].map((text) => ({ text, embedding: [0.1, 0.2] })),
      });
      expect(embedBatch).toHaveBeenCalledWith(["hello", "world"], { inputType: "document" });
      expect(closeProvider).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["deepinfra", "Qwen/Qwen3-Embedding-8B", "Qwen"],
    ["openai", "gemini/gemini-embedding-001", "gemini"],
  ])(
    "rejects --provider %s that conflicts with --model %s before creating a provider",
    async (provider, model, modelProvider) => {
      await expect(create("--provider", provider, "--model", model, "--json")).rejects.toThrow(
        "exit 1",
      );
      expect(providerCall()).toBeUndefined();
      expectError(
        `Embedding --provider "${provider}" must match the provider "${modelProvider}" in --model.`,
      );
    },
  );

  it("shows ordered embedding dimensions and bounded vector previews in text output", async () => {
    embedBatch.mockResolvedValueOnce([
      [0.1, -0.2],
      Array.from({ length: 1536 }, (_, index) => index + 1),
      [],
    ]);

    await create("--text", "world", "--text", "");

    expect(log).toHaveBeenCalledWith(`embedding.create via local
provider: openai
model: text-embedding-3-small
outputs: 3
hello
dimensions: 2
embedding: [0.1, -0.2]
world
dimensions: 1536
embedding: [1, 2, 3, 4, 5, 6, 7, 8, ...]

dimensions: 0
embedding: []`);
  });

  it.each(["sync", "async"])(
    "preserves the primary embedding failure when %s cleanup fails",
    async (mode) => {
      closeProvider.mockImplementationOnce(() => {
        if (mode === "sync") {
          throw new Error("close failed");
        }
        return Promise.reject(new Error("close failed"));
      });
      embedBatch.mockRejectedValueOnce(new Error("embedding failed"));
      await expect(create("--json")).rejects.toThrow("exit 1");
      expect(closeProvider).toHaveBeenCalledTimes(1);
      expectError("embedding failed");
    },
  );
}
