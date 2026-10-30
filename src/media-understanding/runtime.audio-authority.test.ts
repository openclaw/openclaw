import { ok } from "@openclaw/normalization-core/result";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";
import { createTalkFileTranscriptionSession } from "../gateway/talk/file-transcription.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { installPinnedHostnameTestHooks } from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";
import type { MediaUnderstandingProvider } from "./types.js";

const cli = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: cli,
}));

installPinnedHostnameTestHooks();
beforeEach(() => {
  cli.mockReset().mockResolvedValue({ stdout: "CLI fallback", stderr: "" });
});
afterEach(() => vi.useRealTimers());

const providerId = "synthetic-audio";
const providerConfig = {
  baseUrl: "https://unused.invalid",
  apiKey: "synthetic-fixture-key",
  models: [],
};
const providerMetadata = {
  id: providerId,
  contracts: { mediaUnderstandingProviders: [providerId] },
};
const cfg: OpenClawConfig = {
  models: { providers: { [providerId]: providerConfig } },
  tools: {
    media: {
      models: [
        { provider: providerId, model: "whisper", capabilities: ["audio"] },
        {
          type: "cli",
          command: process.execPath,
          args: ["{{AttachmentPath}}"],
          capabilities: ["audio"],
        },
      ],
    },
  },
};

it.each([
  ["retry", "allowed", 2, 1, "CLI fallback"],
  ["retry", "closed", 1, 0, null],
  ["retry", "revoked", 1, 0, null],
  ["http", "allowed", 1, 0, "HTTP transcript"],
  ["http", "closed", 0, 0, null],
  ["http", "revoked", 0, 0, null],
] as const)(
  "revalidates %s capture authority when %s",
  async (phase, state, calls, cliCalls, transcript) => {
    const started = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const upload = vi.fn<typeof fetch>(async () => Response.json({ text: "HTTP transcript" }));
    const transcribeAudio = vi.fn<NonNullable<MediaUnderstandingProvider["transcribeAudio"]>>(
      async () => {
        if (transcribeAudio.mock.calls.length === 1) {
          started.resolve();
          await release.promise;
        }
        throw Object.assign(new Error("Temporary transcription failure"), { status: 503 });
      },
    );
    const provider: MediaUnderstandingProvider = { id: providerId, capabilities: ["audio"] };
    if (phase === "retry") {
      provider.transcribeAudio = transcribeAudio;
    } else {
      provider.transcribeAudioWithContext = async (request) => {
        started.resolve();
        await release.promise;
        return ok(
          await transcribeOpenAiCompatibleAudio({
            ...request,
            apiKey: "synthetic-fixture-key",
            defaultBaseUrl: "https://speech.example/v1",
            defaultModel: "whisper",
            fetchFn: upload,
          }),
        );
      };
    }
    const registry = createEmptyPluginRegistry();
    registry.mediaUnderstandingProviders.push({ pluginId: providerId, source: "test", provider });
    await withPluginRuntimeGenerationScope(
      {
        pluginRegistry: registry,
        metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [providerMetadata] }),
      },
      async () => {
        const transcripts: string[] = [];
        let current = true;
        const session = createTalkFileTranscriptionSession(
          {
            cfg,
            agentId: "main",
            agentDir: resolveAgentDir(cfg, "main"),
            workspaceDir: resolveAgentWorkspaceDir(cfg, "main"),
            maxBytes: 8192,
            ready: true,
            provider: providerId,
            providers: [{ id: providerId, models: ["whisper"], configured: true }],
          },
          { onTranscript: (text) => transcripts.push(text) },
          () => {
            if (!current) {
              throw new Error("Speech requester authority revoked");
            }
          },
        );
        session.sendAudio(Buffer.alloc(1600, 0xff));
        try {
          if (phase === "retry") {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          }
          const finishing = session.finish();
          const outcome = finishing.then(
            () => true,
            () => false,
          );
          await awaitGateBeforeSettlement(
            started.promise,
            finishing,
            "capture finished before provider gate",
          );
          if (state === "closed") {
            session.close();
          } else if (state === "revoked") {
            current = false;
          }
          release.resolve();
          if (phase === "retry") {
            await vi.advanceTimersByTimeAsync(1000);
          }
          expect(await outcome).toBe(transcript !== null);
          expect(phase === "retry" ? transcribeAudio : upload).toHaveBeenCalledTimes(calls);
          expect(cli).toHaveBeenCalledTimes(cliCalls);
          expect(transcripts).toEqual(transcript === null ? [] : [transcript]);
        } finally {
          session.close();
        }
      },
    );
  },
);
