import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../runtime.js";
import { videoListCommand } from "./video-list.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn().mockReturnValue({}),
  listVideoGenerationProviders: vi.fn().mockReturnValue([]),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../video-generation/provider-registry.js", () => ({
  listVideoGenerationProviders: mocks.listVideoGenerationProviders,
}));

function createMockRuntime(): OutputRuntimeEnv & { output: string[]; jsonOutput: unknown[] } {
  const output: string[] = [];
  const jsonOutput: unknown[] = [];
  return {
    output,
    jsonOutput,
    log: (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    },
    exit: vi.fn() as unknown as (code: number) => never,
    writeStdout: (value: string) => {
      output.push(value);
    },
    writeJson: (value: unknown) => {
      jsonOutput.push(value);
    },
  };
}

describe("videoListCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists providers in table format", async () => {
    mocks.listVideoGenerationProviders.mockReturnValue([
      {
        id: "google",
        label: "Google Veo",
        defaultModel: "veo-3",
        models: ["veo-3", "veo-3.1"],
        capabilities: {
          supportsAudio: true,
          supportsAspectRatio: true,
          supportsResolution: false,
          maxDurationSeconds: 8,
        },
        isConfigured: () => true,
      },
      {
        id: "openai",
        label: "OpenAI Sora",
        defaultModel: "sora-2",
        models: ["sora-2"],
        capabilities: {
          supportsAudio: false,
          supportsAspectRatio: true,
          supportsResolution: true,
          maxDurationSeconds: 12,
        },
        isConfigured: () => false,
      },
    ]);

    const runtime = createMockRuntime();
    await videoListCommand({}, runtime);

    const tableOutput = runtime.output.join("\n");
    expect(tableOutput).toContain("google");
    expect(tableOutput).toContain("openai");
    expect(tableOutput).toContain("veo-3");
    expect(tableOutput).toContain("sora-2");
  });

  it("outputs JSON when --json flag is set", async () => {
    mocks.listVideoGenerationProviders.mockReturnValue([
      {
        id: "runway",
        defaultModel: "gen4.5",
        models: ["gen4.5"],
        capabilities: { supportsAudio: false },
        isConfigured: () => true,
      },
    ]);

    const runtime = createMockRuntime();
    await videoListCommand({ json: true }, runtime);

    expect(runtime.jsonOutput).toHaveLength(1);
    const result = runtime.jsonOutput[0] as Array<{ id: string }>;
    expect(result[0].id).toBe("runway");
    expect(result[0]).toHaveProperty("configured", true);
  });

  it("handles no providers gracefully", async () => {
    mocks.listVideoGenerationProviders.mockReturnValue([]);

    const runtime = createMockRuntime();
    await videoListCommand({}, runtime);

    const tableOutput = runtime.output.join("\n");
    expect(tableOutput).toContain("No video generation providers available");
  });

  it("sorts providers alphabetically", async () => {
    mocks.listVideoGenerationProviders.mockReturnValue([
      {
        id: "runway",
        models: [],
        capabilities: {},
      },
      {
        id: "alibaba",
        models: [],
        capabilities: {},
      },
    ]);

    const runtime = createMockRuntime();
    await videoListCommand({ json: true }, runtime);

    const result = runtime.jsonOutput[0] as Array<{ id: string }>;
    expect(result[0].id).toBe("alibaba");
    expect(result[1].id).toBe("runway");
  });
});
