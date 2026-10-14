import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const hoisted = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  calls: [] as Array<{ cfg: OpenClawConfig }>,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveLocalCapabilityAgent: vi.fn(async () => ({
    cfg: hoisted.cfg,
    agentId: "main",
    agentDir: "/tmp/agent",
  })),
}));

vi.mock("../../media-understanding/runtime.js", () => {
  const run = async (params: { cfg: OpenClawConfig }) => {
    hoisted.calls.push({ cfg: params.cfg });
    return { text: "ok", provider: "openai", model: "whisper-1" };
  };
  return { transcribeAudioFile: vi.fn(run), describeVideoFile: vi.fn(run) };
});

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: vi.fn(async (_runtime: unknown, run: () => Promise<void>) => await run()),
}));

vi.mock("./output.js", () => ({
  emitJsonOrText: vi.fn(),
  formatEnvelopeForText: vi.fn(),
}));

import { registerMediaUnderstandingCommand } from "./media-understanding-command.js";

async function run(kind: "audio" | "video", argv: string[]): Promise<void> {
  const parent = new Command();
  registerMediaUnderstandingCommand(parent, kind);
  await parent.parseAsync(argv, { from: "user" });
}

describe("infer media understanding --model", () => {
  beforeEach(() => {
    hoisted.calls.length = 0;
    hoisted.cfg = {
      tools: {
        media: {
          models: [
            { provider: "groq", capabilities: ["audio"] },
            { provider: "google", capabilities: ["video"] },
          ],
          audio: { preferredModel: "groq/whisper-large-v3-turbo" },
        },
      },
    };
  });

  it.each([
    ["audio", ["transcribe", "--file", "tone.wav", "--model", "openai/whisper-1"], "whisper-1"],
    ["video", ["describe", "--file", "clip.mp4", "--model", "openai/gpt-5.4"], "gpt-5.4"],
  ] as const)(
    "pins %s to the requested provider/model instead of configured entries",
    async (kind, argv, model) => {
      await run(kind, [...argv]);

      expect(hoisted.calls).toHaveLength(1);
      expect(hoisted.calls[0]?.cfg.tools?.media?.models).toEqual([
        { provider: "openai", model, capabilities: [kind] },
      ]);
      expect(hoisted.calls[0]?.cfg.tools?.media?.audio).toEqual(hoisted.cfg.tools?.media?.audio);
    },
  );

  it("keeps configured entries when --model is omitted", async () => {
    await run("audio", ["transcribe", "--file", "tone.wav"]);

    expect(hoisted.calls[0]?.cfg).toBe(hoisted.cfg);
  });
});
