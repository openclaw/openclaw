import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import { MIN_AUDIO_FILE_BYTES } from "../../../../src/media-understanding/defaults.constants.js";
import type { MediaUnderstandingProvider } from "../../../../src/media-understanding/types.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { audioConfig } from "./media-understanding.test-support.js";

vi.mock("../../../../src/plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  it("falls through from a failed provider to an actual temporary CLI executable", async () => {
    const dir = tempDirs.make("openclaw-qa-media-audio-fallback-");
    const audioPath = path.join(dir, "fallback.wav");
    await fs.writeFile(audioPath, Buffer.alloc(MIN_AUDIO_FILE_BYTES + 1, 0x11));
    const executable = await writePortableTranscriber(dir);
    const providerAttempts: string[] = [];
    const ctx: MsgContext = {
      Body: "",
      media: [{ path: audioPath, contentType: "audio/wav" }],
    };
    const cfg = audioConfig(
      "qa-stt",
      "fixture-stt",
      { apiKey: "qa-test-key", baseUrl: "https://qa.invalid", models: [] }, // pragma: allowlist secret
      {},
      [
        {
          type: "cli",
          command: executable.command,
          args: executable.args,
          capabilities: ["audio"],
        },
      ],
    );
    const provider: MediaUnderstandingProvider = {
      id: "qa-stt",
      capabilities: ["audio"],
      resolveAuth: () => ({ kind: "none", source: "qa-product-fixture" }),
      transcribeAudio: async ({ fileName }) => {
        providerAttempts.push(fileName);
        throw new Error("intentional provider failure");
      },
    };

    await applyMediaUnderstanding({
      ctx,
      cfg,
      providers: { "qa-stt": provider },
      processingMode: "audio-only",
      workspaceDir: dir,
    });

    expect(providerAttempts).toEqual(["fallback.wav"]);
    expect(await fs.readFile(executable.markerPath, "utf8")).toBe(await fs.realpath(audioPath));
    expect(ctx.Transcript).toBe("cli transcript:fallback.wav");
  });
});
