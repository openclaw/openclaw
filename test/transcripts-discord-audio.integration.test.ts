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

defineDiscordVoiceTests(
  ({
    expect,
    it,
    createManager,
    makeVoiceConfig,
    getSessionEntry,
    getSessionConnection,
    handleSpeakingStart,
    startTranscripts,
    decodeOpusStreamChunksMock,
    transcribeAudioFileMock,
    agentCommandMock,
    controlRealtimeVoiceAgentRunMock,
    loggerWarnMock,
    receiveRecordedSpeech,
  }) => {
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
        cli
          .mockReset()
          .mockResolvedValueOnce({ stdout: "", stderr: "" })
          .mockResolvedValue({ stdout: suffix, stderr: "" });
        const provider = vi.fn(async ({ buffer, model }: { buffer: Buffer; model?: string }) => {
          if (model === "unavailable-stt") {
            throw new Error("synthetic model unavailable");
          }
          return { text: buffer[44] === 1 ? prefix : suffix };
        });
        const registry = createEmptyPluginRegistry();
        registry.mediaUnderstandingProviders.push({
          pluginId: "synthetic-audio",
          source: "test/transcripts-discord-audio.integration.test.ts",
          provider: { id: "synthetic-audio", capabilities: ["audio"], transcribeAudio: provider },
        });
        // Keep the synthetic runtime and discovery inventory in one generation;
        // transcription must not materialize unrelated bundled plugin owners.
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "synthetic-audio",
              contracts: { mediaUnderstandingProviders: ["synthetic-audio"] },
            },
          ],
        });
        const apiModel: MediaUnderstandingModelConfig = {
          provider: "synthetic-audio",
          model: "synthetic-stt",
          capabilities: ["audio"],
        };
        const models: MediaUnderstandingModelConfig[] =
          opening === "empty CLI"
            ? [
                {
                  type: "cli",
                  command: "synthetic-stt",
                  // The process succeeds with empty stdout; its input is still valid.
                  args: ["{{AttachmentPath}}"],
                  capabilities: ["audio"],
                },
              ]
            : [
                ...(opening === "fallback" ? [{ ...apiModel, model: "unavailable-stt" }] : []),
                apiModel,
              ];
        const cfg = {
          tools: {
            media: {
              audio: { maxBytes: 1_048_576 },
              models,
            },
          },
          models: {
            providers: {
              "synthetic-audio": {
                baseUrl: "https://unused.invalid",
                apiKey: "synthetic-fixture-key",
                models: [],
              },
            },
          },
        };
        const manager = createManager(
          makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
          undefined,
          cfg,
        );
        await manager.join({ guildId: "g1", channelId: "1001" });
        const entry = getSessionEntry(manager);
        const conversations = vi.spyOn(entry.conversations, "enqueue");
        if (dispatch === "control") {
          controlRealtimeVoiceAgentRunMock.mockImplementation(async () => {
            return {
              ok: true,
              mode: "cancel",
              sessionKey: entry.route.sessionKey,
              active: true,
              aborted: true,
              message: "Cancelled",
              speak: false,
              show: true,
              suppress: true,
            };
          });
        }
        const stream = new PassThrough({ objectMode: true });
        getSessionConnection(entry).receiver.subscribe.mockReturnValueOnce(stream);
        const openingDecoded = createDeferred<void>();
        decodeOpusStreamChunksMock.mockImplementation(async (input, options) => {
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
        transcribeAudioFileMock.mockImplementation(async (params) => {
          wavPaths.push(params.filePath);
          wavSizes.push((await fs.stat(params.filePath)).size);
          const result = await withPluginRuntimeGenerationScope(
            { metadataSnapshot, pluginRegistry: registry },
            () => transcribeAudioFile(params),
          );
          results.push(result);
          return result;
        });
        const recorded = createDeferred<void>();
        const sink = vi.fn(() => recorded.resolve());
        const receiving = handleSpeakingStart(manager, entry, "u-owner");
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
            expect(transcribeAudioFileMock).not.toHaveBeenCalled();
            getSessionConnection(entry).receiver.subscribe.mockReturnValueOnce(recordingStream);
            entry.connection.receiver.speaking.users.set("u-owner", Date.now());
          } else {
            await openingDecoded.promise;
          }
          expect(await startTranscripts(manager, sink)).toMatchObject({ ok: true });
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
          expect(loggerWarnMock).not.toHaveBeenCalledWith(expect.stringContaining("cli-missing-"));
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
          expect(provider).toHaveBeenCalledTimes(opening === "empty CLI" ? 0 : oversized ? 1 : 4);
          expect(cli).toHaveBeenCalledTimes(opening === "empty CLI" ? 2 : 0);
          if (oversized) {
            expect(provider.mock.calls[0]![0].buffer).toHaveLength(192_044);
            expect(provider.mock.calls[0]![0].buffer[44]).toBe(2);
          }
          expect(sink).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: suffix }));
          for (const wavPath of wavPaths) {
            await expect(fs.stat(wavPath)).rejects.toMatchObject({ code: "ENOENT" });
          }
          const completeText = opening === "fallback" ? `${prefix}\n${suffix}` : suffix;
          if (oversized) {
            expect(agentCommandMock).not.toHaveBeenCalled();
            expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
          } else if (dispatch === "control") {
            expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledExactlyOnceWith({
              getToolAuthorityOverlay: expect.any(Function),
              sessionKey: entry.route.sessionKey,
              text: completeText,
            });
            expect(agentCommandMock).not.toHaveBeenCalled();
          } else {
            expect(agentCommandMock).toHaveBeenCalledOnce();
            expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
              message: expect.stringContaining(completeText),
            });
            expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
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
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
        undefined,
        { tools: { media: { models: [{ type: "cli", command, args, capabilities: ["audio"] }] } } },
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const sink = vi.fn();
      expect(await startTranscripts(manager, sink)).toMatchObject({ ok: true });
      const wavPaths: string[] = [];
      transcribeAudioFileMock.mockImplementation(async (params) => {
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
      await receiveRecordedSpeech(manager);
      expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
      expect(cli).not.toHaveBeenCalled();
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining(`discord voice: recording failed: ${reason}; Set `),
      );
      expect(sink).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      for (const wavPath of wavPaths) {
        await expect(fs.stat(wavPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  },
);
