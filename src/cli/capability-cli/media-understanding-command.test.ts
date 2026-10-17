import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSafeAudioFixtureBuffer } from "../../media-understanding/runner.test-utils.js";
import type {
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
} from "../../media-understanding/types.js";
import { defaultRuntime } from "../../runtime.js";

type CapturedRequest = {
  provider: string;
  model?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  apiKey: string;
};

const hoisted = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  requests: [] as CapturedRequest[],
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveLocalCapabilityAgent: vi.fn(async () => ({
    cfg: hoisted.cfg,
    agentId: "main",
    agentDir: path.join(path.sep, "nonexistent", "agent"),
  })),
}));

vi.mock("../../media-understanding/provider-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../media-understanding/provider-registry.js")>();
  const provider = (id: string): MediaUnderstandingProvider => {
    const capture = async (req: VideoDescriptionRequest) => {
      hoisted.requests.push({
        provider: id,
        model: req.model,
        baseUrl: req.baseUrl,
        headers: req.headers,
        apiKey: req.apiKey,
      });
      return { text: `${id} output`, model: req.model };
    };
    return {
      id,
      capabilities: ["audio", "video"],
      transcribeAudio: capture,
      describeVideo: capture,
    };
  };
  return {
    ...actual,
    buildMediaUnderstandingRegistry: () =>
      new Map(["openai", "groq", "deepgram", "google"].map((id) => [id, provider(id)])),
  };
});

import { registerMediaUnderstandingCommand } from "./media-understanding-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function providerConfig(id: string) {
  return { baseUrl: `https://${id}.provider.example/v1`, apiKey: `${id}-key`, models: [] };
}

async function run(kind: "audio" | "video", model?: string) {
  const root = tempDirs.make("openclaw-infer-media-model-");
  const file = path.join(root, kind === "audio" ? "tone.wav" : "clip.mp4");
  await fs.writeFile(file, createSafeAudioFixtureBuffer(4096, 0x52));
  const parent = new Command();
  registerMediaUnderstandingCommand(parent, kind);
  await parent.parseAsync(
    [
      kind === "audio" ? "transcribe" : "describe",
      "--file",
      file,
      "--json",
      ...(model ? ["--model", model] : []),
    ],
    { from: "user" },
  );
  return vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
}

describe("infer media understanding --model", () => {
  beforeEach(() => {
    hoisted.requests.length = 0;
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    hoisted.cfg = {
      models: {
        providers: {
          openai: providerConfig("openai"),
          groq: providerConfig("groq"),
          deepgram: providerConfig("deepgram"),
          google: providerConfig("google"),
        },
      },
      tools: {
        media: {
          models: [
            { provider: "groq", capabilities: ["audio"] },
            {
              provider: "deepgram",
              model: "nova-3",
              baseUrl: "https://deepgram.proxy.example/v1",
              headers: { "x-entry": "deepgram-entry" },
              capabilities: ["audio"],
            },
            {
              provider: "openai",
              baseUrl: "https://openai.proxy.example/v1",
              capabilities: ["video"],
            },
            { provider: "google", capabilities: ["video"] },
          ],
          audio: { preferredModel: "groq/whisper-large-v3-turbo" },
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes audio to the requested provider/model instead of the configured entry", async () => {
    const envelope = await run("audio", "openai/whisper-1");

    expect(hoisted.requests).toEqual([
      {
        provider: "openai",
        model: "whisper-1",
        baseUrl: "https://openai.provider.example/v1",
        headers: undefined,
        apiKey: "openai-key",
      },
    ]);
    expect(envelope).toMatchObject({ provider: "openai", model: "whisper-1" });
  });

  it("keeps the matching configured entry transport settings when pinning its model", async () => {
    await run("audio", "deepgram/nova-3");

    expect(hoisted.requests).toEqual([
      {
        provider: "deepgram",
        model: "nova-3",
        baseUrl: "https://deepgram.proxy.example/v1",
        headers: { "x-entry": "deepgram-entry" },
        apiKey: "deepgram-key",
      },
    ]);
  });

  it("pins video and keeps the provider-wide configured entry settings", async () => {
    const envelope = await run("video", "openai/gpt-5.4");

    expect(hoisted.requests).toEqual([
      {
        provider: "openai",
        model: "gpt-5.4",
        baseUrl: "https://openai.proxy.example/v1",
        headers: undefined,
        apiKey: "openai-key",
      },
    ]);
    expect(envelope).toMatchObject({ provider: "openai", model: "gpt-5.4" });
  });

  it("keeps configured routing when --model is omitted", async () => {
    await run("audio");

    expect(hoisted.requests).toEqual([
      {
        provider: "groq",
        model: "whisper-large-v3-turbo",
        baseUrl: "https://groq.provider.example/v1",
        headers: undefined,
        apiKey: "groq-key",
      },
    ]);
  });
});
