import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { TypingMode } from "../../config/types.js";
import {
  getSessionControllerOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import type { TemplateContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { buildChannelSourceTurnId, setChannelSourceTurnId } from "./source-turn-id.js";
import { createMockTypingController } from "./test-helpers.js";

export function createReplyAgentSessionFixture() {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  const sessionKeys = new Set<string>();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      try {
        // Reply completion starts asynchronous recovery-owner release. Join it before
        // deleting stores so late cleanup cannot recreate a previous case's database.
        await Promise.all(
          [...sessionKeys].map((sessionKey) => waitForReplyRunSuccessorAdmission(sessionKey, null)),
        );
        for (const dir of tempDirs.dirs) {
          await closeOpenClawAgentDatabasesAsync(dir);
        }
        sessionKeys.clear();
        cleanup();
      } finally {
        clearRuntimeConfigSnapshot();
      }
    }),
  );
  return {
    sessionKeys,
    tempDirs,
    async createSessionStoreFile(
      this: void,
      entry: SessionEntry,
      sessionKey = "main",
    ): Promise<string> {
      sessionKeys.add(sessionKey);
      const dir = tempDirs.make("openclaw-agent-runner-");
      const storePath = join(dir, "sessions.json");
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      return storePath;
    },
  };
}

export async function runSuccessfulReplyModelFixture(
  params: RunEmbeddedAgentParams,
): Promise<EmbeddedAgentRunResult> {
  return {
    payloads: [{ text: "final" }],
    meta: {
      durationMs: 0,
      agentMeta: {
        sessionId: params.sessionId,
        provider: expectDefined(params.provider, "attempt provider"),
        model: expectDefined(params.model, "attempt model"),
      },
    },
  };
}

export function createMinimalReplyAgentRunFactory({
  sessionKeys,
  getRunReplyAgent,
  state,
  track,
}: {
  sessionKeys: Set<string>;
  getRunReplyAgent: () => Promise<(typeof import("./agent-runner-run.js"))["runReplyAgent"]>;
  state: {
    activeBackendCancelMock: Mock;
    backendQueueMessageMock: Mock;
  };
  track: (run: FollowupRun) => void;
}) {
  return function createMinimalRun(params?: {
    opts?: InternalGetReplyOptions;
    resolvedVerboseLevel?: "off" | "on";
    sessionStore?: Record<string, SessionEntry>;
    sessionEntry?: SessionEntry;
    sessionKey?: string;
    storePath?: string;
    typingMode?: TypingMode;
    blockStreamingEnabled?: boolean;
    isActive?: boolean;
    isRunActive?: () => boolean;
    shouldSteer?: boolean;
    shouldFollowup?: boolean;
    resolvedQueueMode?: string;
    replyOperation?: ReplyOperation;
    currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
    sessionCtx?: Partial<TemplateContext>;
    sourceTurnId?: string;
    runOverrides?: Partial<FollowupRun["run"]>;
    bindActiveAuthority?: boolean;
    attachSteerBackend?: boolean;
    activeBackendRunId?: string;
    runtimePolicySessionKey?: string;
  }) {
    const typing = createMockTypingController();
    const opts = params?.opts;
    const sessionCtx = {
      Provider: "whatsapp",
      SenderId: "sender-42",
      MessageSid: "msg",
      ...params?.sessionCtx,
    } as unknown as TemplateContext;
    const sourceTurnId =
      params?.sourceTurnId ??
      buildChannelSourceTurnId({
        provider: sessionCtx.Provider,
        accountId: sessionCtx.AccountId,
        conversationId: sessionCtx.OriginatingTo,
        messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      });
    setChannelSourceTurnId(sessionCtx, sourceTurnId);
    const resolvedQueue = {
      mode: params?.resolvedQueueMode ?? "interrupt",
      debounceMs: 0,
    } as unknown as QueueSettings;
    const sessionKey = params?.sessionKey ?? "main";
    const config = params?.runOverrides?.config ?? {};

    const followupRun = {
      prompt: "hello",
      sourceTurnId,
      abortSignal: opts?.abortSignal,
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      turnAdoptionLifecycle: opts?.turnAdoptionLifecycle,
      currentInboundEventKind: params?.currentInboundEventKind,
      originatingChannel: sessionCtx.OriginatingChannel ?? sessionCtx.Provider,
      originatingTo: sessionCtx.OriginatingTo,
      originatingChatId: sessionCtx.NativeChannelId ?? sessionCtx.ChatId,
      run: {
        agentId: "main",
        sessionId: params?.sessionEntry?.sessionId ?? "session",
        sessionKey,
        messageProvider: "whatsapp",
        senderId: sessionCtx.SenderId,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        // Mocked reply routes already have prepared input facts; discovery has its own vision tests.
        thinkingCatalog: [
          { provider: "anthropic", id: "claude", input: ["text"] },
          { provider: "anthropic", id: "claude-opus-4-7", input: ["text"] },
          { provider: "openai", id: "gpt-5.5", input: ["text"] },
          { provider: "openai", id: "gpt-5.6-sol", input: ["text"] },
          { provider: "google", id: "gemini-2.5-flash", input: ["text"] },
          { provider: "deepinfra", id: "moonshotai/Kimi-K2.5", input: ["text"] },
          { provider: "lmstudio", id: "gemma-4-e4b-it", input: ["text"] },
        ],
        thinkLevel: "low",
        verboseLevel: params?.resolvedVerboseLevel ?? "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
        skipProviderRuntimeHints: process.env.OPENCLAW_TEST_FAST === "1",
        ...params?.runOverrides,
        // Mailbox admission and persistence must select the same physical store.
        config: params?.storePath
          ? { ...config, session: { ...config.session, store: params.storePath } }
          : config,
      },
    } as unknown as FollowupRun;
    sessionKeys.add(sessionKey);
    track(followupRun);
    const activeOperation = getSessionControllerOperation(sessionKey);
    const activeAuthority =
      activeOperation && params?.isActive && params.bindActiveAuthority !== false
        ? prepareReplyToolAuthority(followupRun)
        : undefined;

    return {
      followupRun,
      sourceTurnId,
      typing,
      opts,
      run: async () => {
        setRuntimeConfigSnapshot(followupRun.run.config);
        if (activeOperation && activeAuthority) {
          await activeOperation.bindToolAuthoritySnapshotAsync(activeAuthority);
        }
        const runReplyAgent = await getRunReplyAgent();
        const operation = getSessionControllerOperation(sessionKey);
        if (operation && params?.attachSteerBackend !== false) {
          operation.attachBackend({
            kind: "embedded",
            runId: params?.activeBackendRunId,
            cancel: state.activeBackendCancelMock,
            supportsTranscriptCommitWait: true,
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              claimPendingUserInputAnswer: async (prompt, options, assertCurrent) => {
                assertCurrent();
                const result = (await state.backendQueueMessageMock(
                  operation.sessionId,
                  prompt,
                  options,
                )) as boolean | { queued: boolean };
                return result === true || (typeof result === "object" && result.queued);
              },
              queueMessage: async (prompt, options, assertCurrent) => {
                assertCurrent();
                const result = (await state.backendQueueMessageMock(
                  operation.sessionId,
                  prompt,
                  options,
                )) as
                  | boolean
                  | {
                      queued: boolean;
                      reason?: string;
                      transcriptCommit?: "unconfirmed";
                      errorMessage?: string;
                    };
                if (result === false || (typeof result === "object" && !result.queued)) {
                  throw new Error(typeof result === "object" ? result.reason : "queue rejected");
                }
                return typeof result === "object" && result.transcriptCommit === "unconfirmed"
                  ? {
                      transcriptCommit: result.transcriptCommit,
                      errorMessage: result.errorMessage ?? "commit unconfirmed",
                    }
                  : undefined;
              },
            },
          });
        }
        return runReplyAgent({
          commandBody: "hello",
          followupRun,
          queueKey: sessionKey,
          resolvedQueue,
          shouldSteer: params?.shouldSteer ?? false,
          shouldFollowup: params?.shouldFollowup ?? false,
          isActive: params?.isActive ?? false,
          isRunActive: params?.isRunActive,
          opts,
          typing,
          sessionEntry: params?.sessionEntry,
          sessionStore: params?.sessionStore,
          sessionKey,
          runtimePolicySessionKey: params?.runtimePolicySessionKey,
          storePath: params?.storePath,
          sessionCtx,
          defaultModel: "anthropic/claude-opus-4-6",
          resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
          isNewSession: false,
          blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
          resolvedBlockStreamingBreak: "message_end",
          shouldInjectGroupIntro: false,
          typingMode: params?.typingMode ?? "instant",
          replyOperation: params?.replyOperation,
        });
      },
    };
  };
}
