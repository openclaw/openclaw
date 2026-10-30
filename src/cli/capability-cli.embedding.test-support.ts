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
        outputs: ["hello", "world"].map((text) => ({ text, embedding: [0.1, 0.2] })),
      });
      expect(closeProvider).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects conflicting provider and model prefixes before creating a provider", async () => {
    await expect(
      create("--provider", "deepinfra", "--model", "Qwen/Qwen3-Embedding-8B", "--json"),
    ).rejects.toThrow("exit 1");
    expect(providerCall()).toBeUndefined();
    expectError('Embedding --provider "deepinfra" must match the provider "Qwen" in --model.');
  });

  it("shows ordered embedding dimensions and bounded vector previews in text output", async () => {
    embedBatch.mockResolvedValueOnce([
      [0.1, -0.2],
      Array.from({ length: 9 }, (_, index) => index + 1),
      [],
    ]);

    await create("--text", "world", "--text", "");

    expect(log).toHaveBeenCalledWith(
      "embedding.create via local\nprovider: openai\nmodel: text-embedding-3-small\noutputs: 3\n" +
        "hello\ndimensions: 2\nembedding: [0.1, -0.2]\n" +
        "world\ndimensions: 9\nembedding: [1, 2, 3, 4, 5, 6, 7, 8, ...]\n" +
        "\ndimensions: 0\nembedding: []",
    );
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
