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

const cfg: OpenClawConfig = {
  models: {
    providers: {
      "synthetic-audio": {
        baseUrl: "https://unused.invalid",
        apiKey: "synthetic-fixture-key",
        models: [],
      },
    },
  },
  tools: {
    media: {
      audio: { enabled: true, maxBytes: 8192 },
      models: [
        { provider: "synthetic-audio", model: "whisper", capabilities: ["audio"] },
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

async function withCapture(
  provider: Pick<MediaUnderstandingProvider, "transcribeAudio" | "transcribeAudioWithContext">,
  run: (capture: {
    session: ReturnType<typeof createTalkFileTranscriptionSession>;
    transcripts: string[];
    revoke: () => void;
  }) => Promise<void>,
) {
  const registry = createEmptyPluginRegistry();
  registry.mediaUnderstandingProviders.push({
    pluginId: "synthetic-audio",
    source: "test",
    provider: { id: "synthetic-audio", capabilities: ["audio"], ...provider },
  });
  await withPluginRuntimeGenerationScope(
    {
      pluginRegistry: registry,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "synthetic-audio",
            contracts: { mediaUnderstandingProviders: ["synthetic-audio"] },
          },
        ],
      }),
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
          provider: "synthetic-audio",
          providers: [{ id: "synthetic-audio", models: ["whisper"], configured: true }],
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
        await run({
          session,
          transcripts,
          revoke: () => {
            current = false;
          },
        });
      } finally {
        session.close();
      }
    },
  );
}

it.each(["allowed", "closed", "revoked"] as const)(
  "retains %s capture authority across provider retry and CLI fallback",
  async (state) => {
    const started = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const transcribeAudio = vi.fn<NonNullable<MediaUnderstandingProvider["transcribeAudio"]>>(
      async () => {
        if (transcribeAudio.mock.calls.length === 1) {
          started.resolve();
          await release.promise;
        }
        throw Object.assign(new Error("Temporary transcription failure"), { status: 503 });
      },
    );
    await withCapture({ transcribeAudio }, async ({ session, transcripts, revoke }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const finishing = session.finish();
      const outcome = finishing.then(
        () => true,
        () => false,
      );
      await awaitGateBeforeSettlement(
        started.promise,
        finishing,
        "capture finished before provider",
      );
      if (state === "closed") {
        session.close();
      } else if (state === "revoked") {
        revoke();
      }
      release.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toBe(state === "allowed");
      expect(transcribeAudio).toHaveBeenCalledTimes(state === "allowed" ? 2 : 1);
      expect(cli).toHaveBeenCalledTimes(state === "allowed" ? 1 : 0);
      expect(transcripts).toEqual(state === "allowed" ? ["CLI fallback"] : []);
    });
  },
);

it.each(["allowed", "closed", "revoked"] as const)(
  "revalidates %s capture at HTTP dispatch after provider preparation",
  async (state) => {
    const prepared = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const upload = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ text: "HTTP transcript" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    await withCapture(
      {
        transcribeAudioWithContext: async (request) => {
          prepared.resolve();
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
        },
      },
      async ({ session, transcripts, revoke }) => {
        const finishing = session.finish();
        const outcome = finishing.then(
          () => true,
          () => false,
        );
        await awaitGateBeforeSettlement(
          prepared.promise,
          finishing,
          "capture finished before preparation",
        );
        if (state === "closed") {
          session.close();
        } else if (state === "revoked") {
          revoke();
        }
        release.resolve();
        expect(await outcome).toBe(state === "allowed");
        expect(upload).toHaveBeenCalledTimes(state === "allowed" ? 1 : 0);
        expect(cli).not.toHaveBeenCalled();
        expect(transcripts).toEqual(state === "allowed" ? ["HTTP transcript"] : []);
      },
    );
  },
);
