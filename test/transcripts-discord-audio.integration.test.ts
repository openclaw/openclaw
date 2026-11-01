import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { vi } from "vitest";
import { loadDiscordVoiceTestHarness } from "../extensions/discord/test-api.js";
import type { MediaUnderstandingModelConfig } from "../src/config/types.tools.js";
import { createPluginMetadataSnapshotFixture } from "../src/plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../src/plugins/runtime/generation-scope.js";

const { defineDiscordVoiceTests } = await loadDiscordVoiceTestHarness();
const cli = vi.hoisted(() => vi.fn());
vi.mock("../src/process/exec.js", () => ({ runExec: cli }));
const audioId = "synthetic-audio";
const audioEndpoint = () => ({
  baseUrl: "https://unused.invalid",
  apiKey: "synthetic-fixture-key",
  models: [],
});

defineDiscordVoiceTests((h) => {
  const { expect, it, agentCommandMock: agent, controlRealtimeVoiceAgentRunMock: control } = h;
  const joinManager = async (config: Parameters<typeof h.createManager>[2]) => {
    const manager = h.createManager(
      h.makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
      undefined,
      config,
    );
    await manager.join({ guildId: "g1", channelId: "1001" });
    return manager;
  };
  const expectWavsRemoved = async (paths: string[]) => {
    for (const wavPath of paths) {
      await expect(fs.stat(wavPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  };
  const cliModel = (command?: string, args?: string[]): MediaUnderstandingModelConfig => ({
    type: "cli",
    command,
    args,
    capabilities: ["audio"],
  });
  it.each(
    ["conversation", "control"].flatMap((dispatch) =>
      ["oversized", "empty CLI", "fallback"].map((opening) => ({ dispatch, opening })),
    ),
  )(
    "preserves whole-utterance $dispatch across capture with $opening opening audio",
    async ({ dispatch, opening }) => {
      const suffix = dispatch === "control" ? "stop that" : "send the update";
      const oversized = opening === "oversized";
      const prefix = oversized ? "Do not" : dispatch === "control" ? "please" : "Opening context";
      const openingFrames = oversized ? 300 : 50;
      cli.mockReset().mockImplementation(async (_command: string, [filePath]: string[]) => {
        const wav = await fs.readFile(filePath!);
        return { stdout: wav[44] === 1 ? "" : suffix, stderr: "" };
      });
      const provider = vi.fn(async ({ buffer, model }: { buffer: Buffer; model?: string }) => {
        if (model === "unavailable-stt") {
          throw new Error("synthetic model unavailable");
        }
        return { text: buffer[44] === 1 ? prefix : suffix };
      });
      const registry = createEmptyPluginRegistry();
      registry.mediaUnderstandingProviders.push({
        pluginId: audioId,
        source: "test/transcripts-discord-audio.integration.test.ts",
        provider: { id: audioId, capabilities: ["audio"], transcribeAudio: provider },
      });
      // Keep the synthetic runtime and discovery inventory in one generation;
      // transcription must not materialize unrelated bundled plugin owners.
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: audioId, contracts: { mediaUnderstandingProviders: [audioId] } }],
      });
      const apiModel: MediaUnderstandingModelConfig = {
        provider: audioId,
        model: "synthetic-stt",
        capabilities: ["audio"],
      };
      const models: MediaUnderstandingModelConfig[] =
        opening === "empty CLI"
          ? [cliModel("synthetic-stt", ["{{AttachmentPath}}"])]
          : [
              ...(opening === "fallback" ? [{ ...apiModel, model: "unavailable-stt" }] : []),
              apiModel,
            ];
      const cfg = {
        tools: { media: { audio: { maxBytes: 1_048_576 }, models } },
        models: { providers: { [audioId]: audioEndpoint() } },
      };
      const manager = await joinManager(cfg);
      const entry = h.getSessionEntry(manager);
      const conversations = vi.spyOn(entry.conversations, "enqueue");
      if (dispatch === "control") {
        control.mockResolvedValue({
          ok: true,
          mode: "cancel",
          sessionKey: entry.route.sessionKey,
          active: true,
          aborted: true,
          message: "Cancelled",
          speak: false,
          show: true,
          suppress: true,
        });
      }
      const stream = new PassThrough({ objectMode: true });
      h.getSessionConnection(entry).receiver.subscribe.mockReturnValueOnce(stream);
      const openingDecoded = createDeferred<void>();
      h.decodeOpusStreamChunksMock.mockImplementation(async (input, options) => {
        let frames = 0;
        for await (const packet of input) {
          await options.onChunk(packet, packet);
          if (++frames === openingFrames) {
            openingDecoded.resolve();
          }
        }
      });
      const wavSizes: number[] = [];
      const wavPaths: string[] = [];
      const results: Awaited<ReturnType<typeof transcribeAudioFile>>[] = [];
      const suffixTranscribed = createDeferred<void>();
      h.transcribeAudioFileMock.mockImplementation(async (params) => {
        wavPaths.push(params.filePath);
        const wav = await fs.readFile(params.filePath);
        wavSizes.push(wav.length);
        const isOpening = wav[44] === 1;
        // Uncaptured conversation and captured audio may finish out of order.
        if (opening === "empty CLI" && isOpening) {
          await suffixTranscribed.promise;
        }
        const result = await withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry: registry },
          () => transcribeAudioFile(params),
        );
        results[oversized || isOpening ? 0 : 1] = result;
        if (!isOpening) {
          suffixTranscribed.resolve();
        }
        return result;
      });
      const recorded = createDeferred<void>();
      const sink = vi.fn(() => recorded.resolve());
      const receiving = h.handleSpeakingStart(manager, entry, "u-owner");
      const receivingOutcome = oversized
        ? expect(receiving).rejects.toThrow("speak a shorter segment")
        : receiving;
      const recordingStream = oversized ? new PassThrough({ objectMode: true }) : stream;
      try {
        // Main rejects oversized uncaptured input before writing a WAV. A later
        // capture scan may record its suffix, but cannot admit it as a new command.
        // Successful-empty and fallback siblings use a one-second opening chunk.
        for (let frame = 0; frame < openingFrames; frame++) {
          if (stream.destroyed) {
            break;
          }
          stream.write(Buffer.alloc(3_840, 1));
          await setImmediate();
        }
        if (oversized) {
          await receivingOutcome;
          expect(stream.destroyed).toBe(true);
          expect(h.transcribeAudioFileMock).not.toHaveBeenCalled();
          h.getSessionConnection(entry).receiver.subscribe.mockReturnValueOnce(recordingStream);
          entry.audio.speakingUsers.add("u-owner");
        } else {
          await openingDecoded.promise;
        }
        expect(await h.startTranscripts(manager, sink)).toMatchObject({ ok: true });
        for (let frame = 0; frame < 50; frame++) {
          recordingStream.write(Buffer.alloc(3_840, 2));
        }
        recordingStream.end();
        await receivingOutcome;
        if (oversized) {
          // The capture scan owns a new receive operation after the rejected opening.
          await recorded.promise;
        }
        await entry.processingQueue;
        // Join owned work even when transcription fails and produces no sink/dispatch call.
        await Promise.all(conversations.mock.results.map((result) => result.value));
        expect(h.loggerWarnMock).not.toHaveBeenCalledWith(expect.stringContaining("cli-missing-"));
        expect(wavSizes).toEqual(oversized ? [192_044] : [192_044, 192_044]);
        expect(results[0]).toMatchObject({
          text: oversized ? suffix : opening === "fallback" ? prefix : undefined,
          decision: {
            outcome: opening === "empty CLI" ? "skipped" : "success",
            attachmentDispositions: {
              0: { kind: opening === "empty CLI" ? "failed" : "handled" },
            },
            attachmentProcessing: { 0: "completed" },
          },
        });
        expect([provider.mock.calls.length, cli.mock.calls.length]).toEqual(
          opening === "empty CLI" ? [0, 2] : [oversized ? 1 : 4, 0],
        );
        if (oversized) {
          const { buffer } = provider.mock.calls[0]![0];
          expect([buffer.length, buffer[44]]).toEqual([192_044, 2]);
        }
        expect(sink).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: suffix }));
        await expectWavsRemoved(wavPaths);
        const completeText = opening === "fallback" ? `${prefix}\n${suffix}` : suffix;
        expect([agent.mock.calls.length, control.mock.calls.length]).toEqual(
          oversized ? [0, 0] : dispatch === "control" ? [0, 1] : [1, 0],
        );
        if (!oversized && dispatch === "control") {
          expect(control).toHaveBeenCalledExactlyOnceWith({
            getToolAuthorityOverlay: expect.any(Function),
            sessionKey: entry.route.sessionKey,
            text: completeText,
          });
        } else if (!oversized) {
          expect(agent.mock.calls[0]?.[0]).toMatchObject({
            message: expect.stringContaining(completeText),
          });
        }
      } finally {
        stream.end();
        recordingStream.end();
        await receivingOutcome;
        await entry.processingQueue;
        conversations.mockRestore();
        await manager.destroy();
      }
    },
  );

  it.each([
    { command: undefined, args: ["{{AttachmentPath}}"], reason: "cli-missing-command" },
    { command: "synthetic-stt", args: undefined, reason: "cli-missing-attachment-arg" },
  ])("finishes voice capture with a warning for $reason", async ({ command, args, reason }) => {
    cli.mockReset();
    const manager = await joinManager({
      tools: { media: { models: [cliModel(command, args)] } },
    });
    const sink = vi.fn();
    expect(await h.startTranscripts(manager, sink)).toMatchObject({ ok: true });
    const wavPaths: string[] = [];
    h.transcribeAudioFileMock.mockImplementation(async (params) => {
      wavPaths.push(params.filePath);
      return await withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
          pluginRegistry: createEmptyPluginRegistry(),
        },
        () => transcribeAudioFile(params),
      );
    });
    // This joins receive, recording, and conversation completion, including refusal.
    await h.receiveRecordedSpeech(manager);
    expect(h.transcribeAudioFileMock).toHaveBeenCalledOnce();
    expect(h.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining(`discord voice: recording failed: ${reason}; Set `),
    );
    expect([cli.mock.calls, sink.mock.calls, agent.mock.calls, control.mock.calls]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    await expectWavsRemoved(wavPaths);
  });
});
