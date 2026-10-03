// Register shared provider boundaries before loading the public ACP claiming hook.
import "./dispatch-acp.shared.test-harness.js";
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { tryDispatchAcpReplyHook } from "../../plugin-sdk/acpx.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAcpSourceTranscriptFixture } from "./dispatch-acp.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import {
  createAcpSessionMeta,
  createAcpTestConfig,
  createAcpTestReplyDispatcherFixture as createDispatcher,
} from "./test-fixtures/acp-runtime.js";

const { auditMocks, managerMocks, sessionKey } =
  await import("./dispatch-acp.shared.test-harness.js");

describe("public ACP source settlement physical ownership", () => {
  it.each(
    (["same", "copied"] as const).flatMap((physicalSource) =>
      [false, true].map((sourceContextAbsent) => ({ physicalSource, sourceContextAbsent })),
    ),
  )(
    "settles only the original physical source after provider completion ($physicalSource file, absent context: $sourceContextAbsent)",
    async ({ physicalSource, sourceContextAbsent }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const runId = `acp-settlement-${physicalSource}-file-${sourceContextAbsent}`;
        const prompt = "Deliver this request once through ACP.";
        const text = "ACP completed the accepted request.";
        const { target, entry, recorder } = await createAcpSourceTranscriptFixture(
          state,
          sessionKey,
          runId,
          prompt,
        );
        managerMocks.resolveSessionAsync.mockResolvedValue({
          kind: "ready",
          sessionKey,
          agentId: target.agentId,
          meta: createAcpSessionMeta(),
          entry,
        });
        const { emitAcpLifecycleEnd } = await vi.importActual<
          typeof import("../../agents/command/acp-lifecycle.js")
        >("../../agents/command/acp-lifecycle.js");
        auditMocks.emitAcpLifecycleEnd.mockImplementationOnce(emitAcpLifecycleEnd);
        let turnAdmission: AdmittedRunContext | undefined;
        let databasePath: string | undefined;
        let originalPath: string | undefined;
        let originalBytes: Buffer | undefined;
        let sourceAtCompletion: ReturnType<typeof loadSessionEntryReadOnly>;
        managerMocks.runTurn.mockImplementationOnce(
          async ({
            admittedRunContext,
            onEvent,
          }: {
            admittedRunContext: AdmittedRunContext;
            onEvent: (event: unknown) => Promise<void>;
          }) => {
            turnAdmission = admittedRunContext;
            expect(getAdmittedRunDelegatedAuthority(turnAdmission)).toBeDefined();
            await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
            await onEvent({ type: "done", status: "completed" });
            const receipt = recorder.getAdmissionReceipt();
            if (!receipt) {
              throw new Error("ACP source transcript was not admitted");
            }
            databasePath = receipt.storePath;
            sourceAtCompletion = loadSessionEntryReadOnly({ ...target, storePath: databasePath });
            expect(sourceAtCompletion).toMatchObject({
              sessionId: target.sessionId,
              status: "running",
              activeWriterRunId: runId,
              lifecycleRunId: runId,
              acpSourceTurn: { sourceSessionId: target.sessionId, runId },
            });
            if (physicalSource === "same") {
              return;
            }

            // Join this fixture's native owners before copying the real, checkpointed database.
            // Logical source and run facts stay identical; only physical authority changes.
            await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
            expect(getAdmittedRunDelegatedAuthority(turnAdmission)).toBeDefined();
            const originalIdentity = readDatabasePathIdentitySync(databasePath);
            originalPath = `${databasePath}.original.sqlite`;
            await fs.rename(databasePath, originalPath);
            for (const suffix of ["-wal", "-shm", "-journal"]) {
              try {
                await fs.rename(`${databasePath}${suffix}`, `${originalPath}${suffix}`);
              } catch (error) {
                if (!hasErrnoCode(error, "ENOENT")) {
                  throw error;
                }
              }
            }
            originalBytes = await fs.readFile(originalPath);
            await fs.copyFile(originalPath, databasePath);
            expect(readDatabasePathIdentitySync(databasePath).key).not.toBe(originalIdentity.key);
            expect(await fs.readFile(databasePath)).toEqual(originalBytes);
          },
        );

        const { dispatcher } = createDispatcher();
        const event = {
          ctx: buildTestCtx({
            Provider: "webchat",
            Surface: "webchat",
            SessionKey: sourceContextAbsent ? undefined : sessionKey,
            BodyForAgent: prompt,
          }),
          runId,
          sessionKey,
          inboundAudio: false,
          shouldRouteToOriginating: false,
          shouldSendToolSummaries: true,
          shouldSendFullToolDetails: false,
          sendPolicy: "allow" as const,
        };
        const hookContext = {
          cfg: createAcpTestConfig({ session: { store: target.storePath } }),
          dispatcher,
          userTurnTranscriptRecorder: recorder,
          recordProcessed: vi.fn(),
          markIdle: vi.fn(),
        };
        const nativeFallback = vi.fn(() => ({
          handled: true,
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        }));
        const { runner } = createHookRunnerWithRegistry([
          {
            hookName: "reply_dispatch",
            pluginId: "acpx",
            priority: 10,
            handler: () => tryDispatchAcpReplyHook(event, hookContext),
          },
          { hookName: "reply_dispatch", pluginId: "native-fallback", handler: nativeFallback },
        ]);
        const result = await runner.runReplyDispatch(event, hookContext);
        expect(result?.handled).toBe(true);
        expect(nativeFallback).not.toHaveBeenCalled();
        expect(managerMocks.runTurn).toHaveBeenCalledOnce();
        const deliveredText = [
          ...vi.mocked(dispatcher.sendBlockReply).mock.calls,
          ...vi.mocked(dispatcher.sendFinalReply).mock.calls,
        ]
          .map(([payload]) => payload.text ?? "")
          .join("");
        expect(deliveredText).toContain(text);
        if (!turnAdmission || !databasePath || !sourceAtCompletion) {
          throw new Error("ACP did not complete its admitted source turn");
        }
        expect(getAdmittedRunDelegatedAuthority(turnAdmission)).toBeUndefined();
        const readSource = async (storePath: string) =>
          withSessionEntryReadOnlyInWorker(
            { ...target, storePath, readConsistency: "latest" },
            () => {},
            async (read) => {
              if (!read.ok) {
                throw read.error;
              }
              return read.value;
            },
          );
        if (physicalSource === "same") {
          const settled = await readSource(databasePath);
          if (!isRecord(settled)) {
            throw new Error("Missing settled ACP source entry");
          }
          expect(settled).toMatchObject({
            sessionId: target.sessionId,
            status: "done",
            lastRunId: runId,
          });
          expect(settled?.activeWriterRunId).toBeUndefined();
          expect(settled?.lifecycleRunId).toBeUndefined();
          expect(settled?.acpSourceTurn).toBeUndefined();
          return;
        }
        expect(await readSource(databasePath)).toEqual(sourceAtCompletion);
        if (!originalPath || !originalBytes) {
          throw new Error("Original ACP source database was not preserved");
        }
        expect(await fs.readFile(originalPath)).toEqual(originalBytes);
        expect(await readSource(originalPath)).toEqual(sourceAtCompletion);
      });
    },
  );
});
