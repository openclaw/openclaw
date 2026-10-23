import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import type {
  MediaUnderstandingAttachmentsConfig,
  MediaUnderstandingModelConfig,
} from "../../../../src/config/types.tools.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import { MIN_AUDIO_FILE_BYTES } from "../../../../src/media-understanding/defaults.constants.js";
import type { MediaUnderstandingProvider } from "../../../../src/media-understanding/types.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { audioConfig } from "./media-understanding.test-support.js";

vi.mock("../../../../src/plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeAudioFixture(dir: string, name: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(MIN_AUDIO_FILE_BYTES + 1, 0x11));
  return filePath;
}

function createSelectionConfig(
  attachments: MediaUnderstandingAttachmentsConfig | undefined,
  fallbackModels: MediaUnderstandingModelConfig[] = [],
) {
  return audioConfig(
    "qa-stt",
    "fixture-stt",
    { apiKey: "qa-test-key", baseUrl: "https://qa.invalid", models: [] }, // pragma: allowlist secret
    { attachments },
    fallbackModels,
  );
}

function createAudioProvider(seenFileNames: string[], fail = false): MediaUnderstandingProvider {
  return {
    id: "qa-stt",
    capabilities: ["audio"],
    resolveAuth: () => ({ kind: "none" as const, source: "qa-product-fixture" }),
    transcribeAudio: async (request: { fileName: string }) => {
      seenFileNames.push(request.fileName);
      if (fail) {
        throw new Error("intentional provider failure");
      }
      return { text: `transcript:${request.fileName}`, model: "fixture-stt" };
    },
  };
}

async function writePortableTranscriber(dir: string) {
  const markerPath = path.join(dir, "cli-ran.txt");
  const scriptPath = path.join(dir, "qa-transcriber.cjs");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const path = require("node:path");
const [markerPath, mediaPath] = process.argv.slice(2);
if (!markerPath || !mediaPath) process.exit(2);
fs.writeFileSync(markerPath, mediaPath);
process.stdout.write(\`cli transcript:\${path.basename(mediaPath)}\\n\`);
`,
  );
  return { command: process.execPath, args: [scriptPath, markerPath, "{{MediaPath}}"], markerPath };
}

describe("QA media audio selection product proof", () => {
  it("applies mixed-attachment preference, mode, caps, and transcript ordering", async () => {
    const dir = tempDirs.make("openclaw-qa-media-audio-selection-");
    const audio = async (name: string) => ({
      path: await writeAudioFixture(dir, name),
      contentType: "audio/ogg",
    });
    const imagePath = path.join(dir, "ignored.png");
    await fs.writeFile(imagePath, Buffer.from("not-an-audio-attachment"));
    const media = [
      await audio("first.ogg"),
      { path: imagePath, contentType: "image/png" },
      await audio("second.ogg"),
      await audio("third.ogg"),
      { ...(await audio("preflight.ogg")), transcribed: true },
    ];

    const select = async (mode: "first" | "all", maxAttachments: number) => {
      const calls: string[] = [];
      const ctx: MsgContext = { Body: "", media };
      await applyMediaUnderstanding({
        ctx,
        cfg: createSelectionConfig({ mode, prefer: "last", maxAttachments }),
        providers: { "qa-stt": createAudioProvider(calls) },
        processingMode: "audio-only",
        workspaceDir: dir,
      });
      return { calls, ctx };
    };
    const { calls: firstModeCalls, ctx: firstModeCtx } = await select("first", 3);

    expect(firstModeCalls).toEqual(["third.ogg"]);
    expect(firstModeCtx.MediaUnderstanding?.map((output) => output.attachmentIndex)).toEqual([3]);
    expect(firstModeCtx.Transcript).toBe("transcript:third.ogg");

    const { calls: allModeCalls, ctx: allModeCtx } = await select("all", 2);

    expect(allModeCalls).toEqual(["third.ogg", "second.ogg"]);
    expect(allModeCtx.MediaUnderstanding?.map((output) => output.attachmentIndex)).toEqual([3, 2]);
    expect(allModeCtx.Transcript).toBe(
      "Audio 1:\ntranscript:third.ogg\n\nAudio 2:\ntranscript:second.ogg",
    );
    expect(allModeCtx.Body).toBe(
      [
        "[Audio 1/2]\nTranscript:\ntranscript:third.ogg",
        "[Audio 2/2]\nTranscript:\ntranscript:second.ogg",
        "[Audio attachment not processed: attachment limit reached]",
      ].join("\n\n"),
    );
  });

  it("falls through from a failed provider to an actual temporary CLI executable", async () => {
    const dir = tempDirs.make("openclaw-qa-media-audio-fallback-");
    const audioPath = await writeAudioFixture(dir, "fallback.wav");
    const executable = await writePortableTranscriber(dir);
    const providerAttempts: string[] = [];
    const ctx: MsgContext = {
      Body: "",
      media: [{ path: audioPath, contentType: "audio/wav" }],
    };
    const cfg = createSelectionConfig(undefined, [
      {
        type: "cli",
        command: executable.command,
        args: executable.args,
        capabilities: ["audio"],
      },
    ]);

    await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: { "qa-stt": createAudioProvider(providerAttempts, true) },
      processingMode: "audio-only",
      workspaceDir: dir,
    });

    expect(providerAttempts).toEqual(["fallback.wav"]);
    expect(await fs.readFile(executable.markerPath, "utf8")).toBe(await fs.realpath(audioPath));
    expect(ctx.Transcript).toBe("cli transcript:fallback.wav");
  });
});
