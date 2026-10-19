import path from "node:path";
import {
  discordVoiceTranscriptsSourceProvider,
  loadDiscordVoiceTestHarness,
  setDiscordTranscriptsVoiceManager,
} from "../extensions/discord/test-api.js";
import { createTranscriptsTool } from "../src/agents/tools/transcripts-tool.js";
import * as workerAdmission from "../src/infra/sqlite-worker-store.js";
import { createPluginMetadataSnapshotFixture } from "../src/plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../src/plugins/runtime/generation-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../src/state/openclaw-state-db.js";
import { TranscriptsStore } from "../src/transcripts/store.js";
import { createDeferred } from "./helpers/promise.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

const { defineDiscordVoiceTests } = await loadDiscordVoiceTestHarness();

defineDiscordVoiceTests((h) => {
  const { expect, expectDefined, it, vi, requireRecord } = h;
  it.each(["manager destruction", "completed", "error", "interleaved finalization"] as const)(
    "retires replaced captures and handles %s without stopping a Discord replacement",
    async (scenario) => {
      const interleaved = scenario === "interleaved finalization";
      const terminal = interleaved ? "manager destruction" : scenario;
      const tempDirs = createTempDirTracker();
      const stateDir = tempDirs.make("discord-transcripts-replacement-");
      const accountId = "transcript-replacement";
      const discordConfig = h.makeVoiceConfig(
        { mode: terminal === "manager destruction" ? "stt-tts" : "agent-proxy" },
        { token: "test-token", groupPolicy: "open", allowFrom: ["discord:u-speaker"] },
      );
      const config = {
        agents: { defaults: { utilityModel: "" } },
        transcripts: { enabled: true },
        channels: { discord: { accounts: { [accountId]: discordConfig } } },
      };
      const manager = h.createManager(
        discordConfig,
        h.createClientWithMember("u-speaker", "Speaker", "0001"),
        config,
        accountId,
      );
      const registry = createEmptyPluginRegistry();
      registry.transcriptSourceProviders.push({
        pluginId: "discord",
        source: "discord/transcripts-source-api.ts",
        provider: discordVoiceTranscriptsSourceProvider,
      });
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "discord", contracts: { transcriptSourceProviders: ["discord-voice"] } }],
      });
      const tool = createTranscriptsTool({
        config,
        stateDir,
        agentId: "transcript-replacement",
        caller: { kind: "operator", source: "local" },
      });
      const execute = (params: Record<string, unknown>) =>
        withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: registry }, () =>
          tool.execute("transcripts", params),
        );
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const source = { providerId: "discord-voice", accountId, guildId: "g1", channelId: "1001" };
      const read = async (sessionId: string) =>
        expectDefined(await store.readSession(sessionId), `${sessionId} capture`);
      const start = (sessionId: string) =>
        expect(execute({ action: "start", sessionId, ...source })).resolves.toMatchObject({
          details: { sessionId, providerId: "discord-voice", accountId },
        });
      const expectStatus = (sessionId?: string, finalized = false) =>
        expect(execute({ action: "status" })).resolves.toMatchObject({
          details: {
            active: sessionId ? [expect.objectContaining({ sessionId })] : [],
            ...(finalized ? { pendingFinalization: [] } : {}),
          },
        });
      const texts = async (session: Parameters<TranscriptsStore["readUtterancesForSession"]>[0]) =>
        (await store.readUtterancesForSession(session)).map((utterance) => utterance.text);
      const join = () =>
        expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toMatchObject({
          ok: true,
        });
      const providerStop = vi.spyOn(discordVoiceTranscriptsSourceProvider, "stop");
      setDiscordTranscriptsVoiceManager({ accountId, manager });
      const finalizerReady = createDeferred();
      let resumeFinalizer: (() => void) | undefined;
      let finalizerCompletion: Promise<string> | undefined;
      const createAdmission = workerAdmission.createSqliteWorkerWriteAdmission;
      const summaryWrite = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
      TranscriptsStore.prototype.writeSummary = function (
        this: TranscriptsStore,
        ...args: Parameters<TranscriptsStore["writeSummary"]>
      ) {
        if (!interleaved || args[1].sessionId !== "first" || finalizerCompletion) {
          return summaryWrite.apply(this, args);
        }
        const completion = createDeferred<string>();
        finalizerCompletion = completion.promise;
        resumeFinalizer = () => {
          resumeFinalizer = undefined;
          void summaryWrite.apply(this, args).then(completion.resolve, completion.reject);
        };
        finalizerReady.resolve();
        return completion.promise;
      };
      const admission = vi
        .spyOn(workerAdmission, "createSqliteWorkerWriteAdmission")
        .mockImplementation((assertCurrent, locations) =>
          createAdmission((request) => {
            // Grant the replacement transaction before its predecessor's finalizer contends.
            if (resumeFinalizer) {
              queueMicrotask(() => resumeFinalizer?.());
            }
            assertCurrent(request);
          }, locations),
        );

      try {
        await start("first");
        const record = (text: string) =>
          h.receiveRecordedSpeech(manager, text, h.getSessionEntry(manager), "u-speaker");
        await record("Keep the original historical note.");

        await start("second");
        if (interleaved) {
          await finalizerReady.promise;
        }
        await record("This belongs only to the replacement.");
        await finalizerCompletion;

        const first = await read("first");
        const second = await read("second");
        const secondTexts = ["This belongs only to the replacement."];
        expect(first.source).toMatchObject(source);
        expect(second.source).toEqual(first.source);
        expect(await texts(first)).toEqual(["Keep the original historical note."]);
        expect(await texts(second)).toEqual(secondTexts);
        h.expectConnectedStatus(manager, "1001");
        expect(providerStop).not.toHaveBeenCalled();

        const status = await execute({ action: "status" });
        const active = requireRecord(status.details, "transcript status").active;
        expect(Array.isArray(active)).toBe(true);
        if (!Array.isArray(active)) {
          throw new Error("expected transcript status active sessions");
        }
        // Keep the stale-status failure first, then exercise historical recovery as well.
        expect
          .soft(active.map((capture) => requireRecord(capture, "active capture").sessionId))
          .toEqual(["second"]);
        await vi.waitFor(async () => {
          expect((await store.readSession("first"))?.stoppedAt).toEqual(expect.any(String));
        });

        await execute({ action: "stop", sessionId: "first" });
        const summarized = await execute({ action: "summarize", sessionId: "first" });
        expect(summarized).toMatchObject({
          details: { summary: { sessionId: "first", utteranceCount: 1 } },
        });
        expect.soft(providerStop).not.toHaveBeenCalled();
        h.expectConnectedStatus(manager, "1001");
        await expectStatus("second");
        if (terminal !== "manager destruction") {
          await join();
        }
        const provider =
          terminal === "manager destruction" ? undefined : h.lastRealtimeBridgeParams();
        const speaker = { userId: "u-speaker", speakerLabel: "Speaker", senderIsOwner: false };
        const beginTurn = () => h.beginSpeakerTurn(h.getSessionEntry(manager), speaker);
        const turn = provider ? beginTurn() : undefined;
        if (provider) {
          const onClose = expectDefined(provider.onClose, "provider terminal callback");
          onClose(terminal === "error" ? "error" : "completed");
          h.expectConnectedStatus(manager, "1001");
          await expectStatus("second", true);
          const ongoing = await read("second");
          expect(ongoing.stoppedAt).toBeUndefined();

          beginTurn();
          const recovered = expectDefined(h.lastRealtimeBridgeParams(), "recovered speaker");
          expect(recovered).not.toBe(provider);
          provider.onTranscript?.("user", "Late text from the retired speaker.", true);
          const recoveredText = "The same capture continues after reconnect.";
          secondTexts.push(recoveredText);
          recovered.onTranscript?.("user", recoveredText, true);
          await record(recoveredText);
          await vi.waitFor(async () => {
            expect(await texts(second)).toEqual(secondTexts);
          });
          expect(providerStop).not.toHaveBeenCalled();
          await expect(manager.leave({ guildId: "g1" })).resolves.toMatchObject({ ok: true });
        } else {
          await manager.destroy();
        }
        expect(manager.status()).toEqual([]);
        await expectStatus("second");
        expect((await store.readSession("second"))?.stoppedAt).toBeUndefined();
        expect(providerStop).not.toHaveBeenCalled();
        await execute({ action: "stop", sessionId: "second" });
        await expectStatus(undefined, true);
        expect(await store.readSession("second")).toMatchObject({
          stoppedAt: expect.any(String),
        });
        expect(providerStop).toHaveBeenCalledOnce();

        if (provider) {
          const stoppedSecond = await read("second");
          await start("third");
          await join();
          turn?.close();
          provider.onClose?.("error");
          provider.onReady?.();
          provider.onTranscript?.("user", "Late text from the retired provider.", true);
          await execute({ action: "stop", sessionId: "second" });
          expect(providerStop).toHaveBeenCalledOnce();
          h.expectConnectedStatus(manager, "1001");
          await expectStatus("third", true);
          expect(await store.readSession("second")).toMatchObject({
            stoppedAt: stoppedSecond.stoppedAt,
          });
          expect(await texts(stoppedSecond)).toEqual(secondTexts);
          const third = await read("third");
          expect(await store.readUtterancesForSession(third)).toEqual([]);
        }
      } finally {
        summaryWrite.mockRestore();
        resumeFinalizer?.();
        await Promise.allSettled([finalizerCompletion]);
        admission.mockRestore();
        try {
          for (const capture of await discordVoiceTranscriptsSourceProvider.status!(source)) {
            if (capture.sessionId) {
              await execute({ action: "stop", sessionId: capture.sessionId });
            }
          }
          await manager.destroy();
          await vi.waitFor(async () => {
            await expectStatus(undefined, true);
          });
        } finally {
          setDiscordTranscriptsVoiceManager({ accountId, manager: null, expectedManager: manager });
          providerStop.mockRestore();
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
          tempDirs.cleanup();
        }
      }
    },
  );
});
