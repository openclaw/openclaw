import {
  forkSqliteSessionAtMessage,
  rewindSqliteSessionToMessage,
} from "./session-accessor.sqlite.js";
import type {
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";

export async function rewindSessionToMessage(
  params: SessionMessageCutMutationParams,
): Promise<SessionMessageCutMutationResult> {
  return await rewindSqliteSessionToMessage(params);
}

export async function forkSessionAtMessage(
  params: SessionMessageCutMutationParams & { targetKey: string },
): Promise<SessionMessageCutMutationResult> {
  return await forkSqliteSessionAtMessage(params);
}
