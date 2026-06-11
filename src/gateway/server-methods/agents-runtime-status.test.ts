import { afterEach, describe, expect, it, vi } from "vitest";

const { __testing: agentsTesting, agentsHandlers } = await import("./agents.js");

afterEach(() => {
  agentsTesting.resetDepsForTests();
});

function callRuntimeStatus() {
  const respond = vi.fn();
  const handler = agentsHandlers["agents.runtime.status"];
  const promise = handler({
    params: {},
    respond,
    context: {} as never,
    req: { type: "req", id: "1", method: "agents.runtime.status" },
    client: null,
    isWebchatConnect: () => false,
  });
  return { promise, respond };
}

describe("agents.runtime.status", () => {
  it("reports running Ollama model memory and context metadata", async () => {
    agentsTesting.setDepsForTests({
      fetchFn: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  name: "qwen3.5:4b",
                  model: "qwen3.5:4b",
                  size: 4_800_000_000,
                  size_vram: 0,
                  context_length: 8192,
                  processor: "cpu",
                  expires_at: "2026-05-04T19:00:00Z",
                  details: {
                    parameter_size: "4B",
                    quantization_level: "Q4_K_M",
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
      execFileFn: vi.fn(async (file, args) => {
        if (file === "vm_stat") {
          return {
            stdout: [
              "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
              "Pages free:                               1000.",
              "Pages speculative:                         200.",
              "Pages purgeable:                            50.",
              "File-backed pages:                         300.",
              "Anonymous pages:                           400.",
              "Pages wired down:                          100.",
              "Pages occupied by compressor:               10.",
            ].join("\n"),
            stderr: "",
          };
        }
        return {
          stdout: String(args?.join(" ")).includes("command=")
            ? [
                "101 422464 /opt/homebrew/bin/ollama",
                "202 1048576 /Applications/Example.app/Contents/MacOS/Example",
                "303 262144 /opt/homebrew/opt/node/bin/node /Users/openclaw/openclaw/dist/entry.js gateway",
              ].join("\n")
            : "422464 /opt/homebrew/bin/ollama\n",
          stderr: "",
        };
      }),
    });

    const { promise, respond } = callRuntimeStatus();
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        system: expect.objectContaining({
          totalBytes: expect.any(Number),
          freeBytes: expect.any(Number),
          usedBytes: expect.any(Number),
          processes: expect.objectContaining({
            available: true,
            ollamaRssBytes: 422_464 * 1024,
            openclawRssBytes: 262_144 * 1024,
            top: expect.arrayContaining([
              expect.objectContaining({ name: "Example", rssBytes: 1_048_576 * 1024 }),
            ]),
          }),
          macosMemory:
            process.platform === "darwin"
              ? expect.objectContaining({
                  available: true,
                  reclaimableBytes: (200 + 50 + 300) * 16_384,
                  availabilityEstimateBytes: (1000 + 200 + 50 + 300) * 16_384,
                })
              : expect.any(Object),
        }),
        localModels: expect.objectContaining({
          provider: "ollama",
          available: true,
          count: 1,
          totalLoadedBytes: 4_800_000_000,
          installedAvailable: true,
          installedModels: [
            expect.objectContaining({
              name: "qwen3.5:4b",
              sizeBytes: 4_800_000_000,
            }),
          ],
          process: expect.objectContaining({
            available: true,
            processCount: 1,
            rssBytes: 422_464 * 1024,
          }),
          models: [
            expect.objectContaining({
              name: "qwen3.5:4b",
              sizeBytes: 4_800_000_000,
              contextLength: 8192,
              parameterSize: "4B",
              quantization: "Q4_K_M",
            }),
          ],
        }),
      }),
      undefined,
    );
  });

  it("keeps the dashboard usable when Ollama runtime telemetry is unavailable", async () => {
    agentsTesting.setDepsForTests({
      fetchFn: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }) as typeof fetch,
      execFileFn: vi.fn(async () => ({ stdout: "", stderr: "" })),
    });

    const { promise, respond } = callRuntimeStatus();
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        localModels: expect.objectContaining({
          provider: "ollama",
          available: false,
          count: 0,
          totalLoadedBytes: 0,
          error: expect.stringContaining("ECONNREFUSED"),
        }),
        warnings: expect.arrayContaining([
          expect.stringContaining("Ollama runtime telemetry is unavailable"),
        ]),
      }),
      undefined,
    );
  });
});
