import { isMainThread } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createCurrentUserProfileMessageProjector,
  prepareChatHistoryRecoveryMessages,
  prepareChatHistoryRecoveryFacts,
  type ChatDisplayProjectionOptions,
} from "./chat-display-projection.core.js";
import { createSubagentCoordinationHistoryProjection } from "./chat-display-projection.history.js";
import {
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.js";
import { mapChatDisplayMessages, joinChatDisplayMessage } from "./chat-display-projection.map.js";
import type {
  ChatTextWorkerInput,
  ChatTextWorkerResult,
  ChatTextWorkerQuery,
  ChatTextWorkerFacts,
} from "./chat-display-projection.worker-types.js";
import { prepareSessionHistorySubagentFacts } from "./session-history-delta-visibility.js";

// Match the existing live-chat buffer envelope; larger history rows belong off-thread.
const MAIN_THREAD_TEXT_BYTES = 500_000 * 2;

/** Strings contribute their length without reading their contents or serializing the message. */
function chatTextInputBytes(value: unknown, limit = Infinity): number {
  const pending = [value];
  let bytes = 0;
  while (pending.length && bytes <= limit) {
    const current = pending.pop();
    if (typeof current === "string") {
      bytes += current.length * 2;
    } else if (Array.isArray(current)) {
      bytes += current.length * 8;
      if (bytes > limit) {
        break;
      }
      for (const child of current) {
        pending.push(child);
      }
    } else if (current && typeof current === "object") {
      for (const key in current) {
        if (!Object.hasOwn(current, key)) {
          continue;
        }
        bytes += 8;
        if (bytes > limit) {
          return bytes;
        }
        // SAFETY: Only own keys of this object are read; their values remain unknown.
        pending.push((current as Record<string, unknown>)[key]);
      }
    }
  }
  return bytes;
}

export function shouldOffloadChatText(value: unknown): boolean {
  return isMainThread && chatTextInputBytes(value, MAIN_THREAD_TEXT_BYTES) > MAIN_THREAD_TEXT_BYTES;
}

type ChatTextRuntime = {
  pool?: WorkerTaskPool<ChatTextWorkerInput, ChatTextWorkerResult>;
  closing?: Promise<void>;
};

export function runChatTextTask<Input extends ChatTextWorkerInput>(
  input: Input,
  options?: ChatDisplayProjectionOptions,
  signal?: AbortSignal,
): Promise<Extract<ChatTextWorkerResult, { kind: Input["kind"] }>>;
export async function runChatTextTask(
  input: ChatTextWorkerInput,
  options?: ChatDisplayProjectionOptions,
  signal?: AbortSignal,
): Promise<ChatTextWorkerResult> {
  const runtime = resolveGlobalSingleton<ChatTextRuntime>(
    Symbol.for("openclaw.chatDisplayProjection"),
    () => ({}),
    (state) => {
      state.closing ??= (async () => {
        await state.pool?.close();
        state.pool = undefined;
      })().finally(() => {
        state.closing = undefined;
      });
      return state.closing;
    },
  );
  if (runtime.closing) {
    throw new WorkerTaskError("Chat display projection is closing", "unavailable");
  }
  const pool = (runtime.pool ??= new WorkerTaskPool({
    workerUrl: resolveRuntimeProcessEntrypointUrl("chatDisplayProjection"),
    workerClass: "compute",
    sharedCompute: true,
  }));
  const assertCurrent = () => {
    signal?.throwIfAborted();
    options?.subagentCoordination?.assertCurrent?.();
  };
  assertCurrent();
  const result = await pool.run(input, {
    signal,
    inputBytes: chatTextInputBytes(input),
    timeoutMs: 120_000,
    async onRequest(value) {
      assertCurrent();
      // SAFETY: Requests come only from the owned worker entry's closed query protocol.
      const query = value as ChatTextWorkerQuery;
      let facts: ChatTextWorkerFacts;
      if (query.kind === "coordination") {
        facts = {
          kind: "coordination",
          value: prepareSessionHistorySubagentFacts(
            expectDefined(options?.subagentCoordination, "chat coordination resolver"),
            (recording) => {
              createSubagentCoordinationHistoryProjection(recording)(query.messages);
            },
          ),
        };
      } else {
        const resolve = expectDefined(options?.resolveCronJobName, "chat cron resolver");
        facts = { kind: "cron", value: query.ids.map((id) => [id, resolve(id)]) };
      }
      assertCurrent();
      return { input: facts, timeoutMs: 120_000 };
    },
  });
  assertCurrent();
  return result;
}

async function projectOversizedChatDisplayMessages(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions,
  signal?: AbortSignal,
): Promise<ReturnType<typeof projectChatDisplayMessagesWithState>> {
  const { subagentCoordination, resolveCronJobName, resolveCurrentUserProfileDisplay, ...plain } =
    options ?? {};
  const result = await runChatTextTask(
    {
      kind: "display",
      messages,
      options: plain,
      subagentCoordination: Boolean(subagentCoordination),
      cronNames: Boolean(resolveCronJobName),
    },
    options,
    signal,
  );
  if (resolveCurrentUserProfileDisplay) {
    result.value.messages = mapChatDisplayMessages(
      result.value.messages,
      createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay),
    );
  }
  options?.subagentCoordination?.assertCurrent?.();
  return result.value;
}

export async function projectChatDisplayMessagesWithStateAsync(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions,
  signal?: AbortSignal,
): Promise<ReturnType<typeof projectChatDisplayMessagesWithState>> {
  signal?.throwIfAborted();
  return shouldOffloadChatText(messages)
    ? projectOversizedChatDisplayMessages(messages, options, signal)
    : projectChatDisplayMessagesWithState(messages, options);
}

export async function projectChatDisplayMessagesAsync(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!shouldOffloadChatText(messages)) {
    return projectChatDisplayMessages(messages, options);
  }
  return (
    await projectOversizedChatDisplayMessages(messages, { ...options, activity: false }, signal)
  ).messages;
}

export async function projectChatDisplayMessageAsync(
  message: unknown,
  options?: ChatDisplayProjectionOptions,
  signal?: AbortSignal,
) {
  return joinChatDisplayMessage(
    await projectChatDisplayMessagesAsync([message], options, signal),
    options?.includeCommentaryFallbacks,
  );
}

export async function prepareChatHistoryRecoveryMessagesAsync(
  messages: unknown[],
  options?: Parameters<typeof prepareChatHistoryRecoveryMessages>[1],
  signal?: AbortSignal,
): Promise<unknown[]> {
  signal?.throwIfAborted();
  if (!shouldOffloadChatText(messages)) {
    return prepareChatHistoryRecoveryMessages(messages, options);
  }
  const { subagentCoordination: _, ...plain } = options ?? {};
  const result = await runChatTextTask(
    { kind: "recovery", messages, options: plain },
    options,
    signal,
  );
  return result.value;
}

export async function prepareChatHistoryRecoveryFactsAsync(
  messages: unknown[],
  options?: Parameters<typeof prepareChatHistoryRecoveryMessages>[1],
  signal?: AbortSignal,
): Promise<ReturnType<typeof prepareChatHistoryRecoveryFacts>> {
  signal?.throwIfAborted();
  if (!shouldOffloadChatText(messages)) {
    return prepareChatHistoryRecoveryFacts(messages, options);
  }
  const { subagentCoordination: _, ...plain } = options ?? {};
  return (
    await runChatTextTask({ kind: "recovery-facts", messages, options: plain }, options, signal)
  ).value;
}
