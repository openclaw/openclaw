import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateTasksHistoryParams,
  TasksHistoryResultSchema,
  type ErrorCode,
  type TasksHistoryResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { TASK_ARCHIVE_RECORD_CAPACITY_ERROR } from "../../config/sessions/session-accessor.sqlite-archive-stream.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { readSessionHistoryPageInWorker } from "../../config/sessions/session-history-worker-runtime.js";
import { cronTaskRecordToRunLogEntry } from "../../cron/task-run-detail.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import { prepareTaskRegistryRead } from "../../tasks/runtime-internal.js";
import { readTaskBackingInstance } from "../../tasks/task-backing-records.js";
import { resolveTaskHistoryHarness, taskTranscriptSessionKey } from "../../tasks/task-history.js";
import { isTerminalTaskStatus, type TaskRecord } from "../../tasks/task-registry.types.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { canReadSessionWithoutSharingMetadata } from "../session-sharing-read.js";
import { canAccessTaskRequesterSession } from "../task-session-access.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_TASK_HISTORY_BYTES = 4 * 1024 * 1024;

function historyBinding(task: TaskRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        task.taskId,
        task.runId,
        task.runtime,
        task.taskKind,
        task.childSessionKey,
        task.agentId,
        task.requesterAgentId,
        task.requesterSessionKey,
        task.ownerKey,
        readTaskBackingInstance(task.detail),
        cronTaskRecordToRunLogEntry(task)?.sessionId,
        taskTranscriptSessionKey(task) ? null : task.detail,
      ]),
    )
    .digest("base64url");
}

function decodeCursor(cursor: string | undefined, binding: string): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== binding ||
    typeof value[1] !== "string" ||
    !value[1]
  ) {
    throw new Error("Invalid task history cursor");
  }
  return value[1];
}

export const taskHistoryHandler: GatewayRequestHandler = async (opts) => {
  const { params, respond, context, client } = opts;
  if (!assertValidParams(params, validateTasksHistoryParams, "tasks.history", respond)) {
    return;
  }
  const fail = (message: string, code: ErrorCode = ErrorCodes.UNAVAILABLE) =>
    respond(false, undefined, errorShape(code, message));
  const read = await prepareTaskRegistryRead();
  if (!read) {
    fail("Task activity did not stabilize. Refresh the task.");
    return;
  }
  const task = read.getTaskById(params.taskId);
  const allowed = (value: TaskRecord | undefined): value is TaskRecord =>
    Boolean(
      value &&
      canAccessTaskRequesterSession({
        cfg: context.getRuntimeConfig(),
        client,
        task: value,
      }),
    );
  if (!allowed(task)) {
    fail("Task not found.", ErrorCodes.INVALID_REQUEST);
    return;
  }
  const binding = historyBinding(task);
  const sessionKey = taskTranscriptSessionKey(task);
  const terminalSubagent = task.runtime === "subagent" && isTerminalTaskStatus(task.status);
  let cursor: string | undefined;
  let offset = 0;
  let cursorSessionId: string | undefined;
  try {
    cursor = decodeCursor(params.cursor, binding);
    if (sessionKey && cursor !== undefined && !cursor.startsWith("archive:")) {
      const live: unknown = JSON.parse(cursor.slice("live:".length));
      if (
        !cursor.startsWith("live:") ||
        !Array.isArray(live) ||
        live.length !== 2 ||
        typeof live[0] !== "string" ||
        !live[0] ||
        typeof live[1] !== "number"
      ) {
        throw new Error("Invalid task history binding");
      }
      [cursorSessionId, offset] = live;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("Invalid task history offset");
      }
    }
  } catch {
    fail("Invalid task history cursor. Refresh the task.", ErrorCodes.INVALID_REQUEST);
    return;
  }
  const harness = resolveTaskHistoryHarness(task);
  let active = true;
  let archiveStore: { agentId: string | undefined; storePath: string } | undefined;
  let requireArchiveAccess = false;
  const archiveAccessAllowed = () => {
    const projection = getSessionRowProjection(context);
    if (!sessionKey || !projection) {
      return false;
    }
    return canReadSessionWithoutSharingMetadata({
      cfg: projection.getPolicyConfig(),
      client,
      sessionKey,
    });
  };
  const assertCurrent = () => {
    const current = read.getTaskById(task.taskId);
    if (
      !active ||
      opts.signal?.aborted ||
      !allowed(current) ||
      (requireArchiveAccess && !archiveAccessAllowed()) ||
      historyBinding(current) !== binding ||
      (sessionKey &&
        task.runtime === "subagent" &&
        !terminalSubagent &&
        isTerminalTaskStatus(current.status)) ||
      (archiveStore &&
        resolveSessionStorePathCore(context.getRuntimeConfig().session?.store, {
          agentId: archiveStore.agentId,
        }) !== archiveStore.storePath) ||
      (!sessionKey && resolveTaskHistoryHarness(current) !== harness)
    ) {
      throw new Error("Task history access changed");
    }
  };
  const publish = (page: TasksHistoryResult) => {
    assertCurrent();
    const result: TasksHistoryResult = {
      messages: page.messages,
      ...(page.activity ? { activity: page.activity } : {}),
      ...(page.nextCursor
        ? {
            nextCursor: Buffer.from(JSON.stringify([binding, page.nextCursor])).toString(
              "base64url",
            ),
          }
        : {}),
    };
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TASK_HISTORY_BYTES ||
      (result.nextCursor?.length ?? 0) > 8192
    ) {
      throw new Error("Task history page exceeds the response limit");
    }
    respond(true, result);
  };
  try {
    const limit = params.limit ?? 100;
    if (sessionKey) {
      const childAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? task.agentId;
      if (terminalSubagent && task.runId && archiveAccessAllowed()) {
        const storePath = resolveSessionStorePathCore(context.getRuntimeConfig().session?.store, {
          agentId: childAgentId,
        });
        archiveStore = { agentId: childAgentId, storePath };
        const { readArchivedTaskHistory } = await import("./task-history-archive.js");
        requireArchiveAccess = true;
        assertCurrent();
        const archived = await readArchivedTaskHistory({
          scope: { agentId: childAgentId, storePath, sessionKey },
          runId: task.runId,
          limit,
          maxBytes: MAX_TASK_HISTORY_BYTES - 16_384,
          ...(cursor?.startsWith("archive:") ? { cursor: cursor.slice("archive:".length) } : {}),
          assertCurrent,
        });
        if (archived) {
          if (cursor && !cursor.startsWith("archive:")) {
            fail("Task history was archived. Refresh the task.", ErrorCodes.INVALID_REQUEST);
            return;
          }
          publish(archived);
          return;
        }
        requireArchiveAccess = false;
      }
      if (cursor?.startsWith("archive:")) {
        throw new Error("The recorded task transcript is unavailable");
      }
      const { handleChatHistoryRequest } = await import("./chat-history-handler.js");
      const { resolveChatHistoryTailReadMaxBytes } = await import("../session-history-tail.js");
      assertCurrent();
      const cronRun = cronTaskRecordToRunLogEntry(task);
      if (cronRun && !cronRun.sessionId) {
        throw new Error("The task has no recorded transcript generation");
      }
      if (cronRun?.sessionId && cursorSessionId && cronRun.sessionId !== cursorSessionId) {
        throw new Error("The task transcript generation changed");
      }
      const storePath = resolveSessionStorePathCore(context.getRuntimeConfig().session?.store, {
        agentId: childAgentId,
      });
      archiveStore = { agentId: childAgentId, storePath };
      const requireCurrentSession = task.runtime === "subagent" && !terminalSubagent;
      const retainedSessionId =
        cronRun?.sessionId ??
        (requireCurrentSession ? undefined : cursorSessionId) ??
        (await withSessionEntryReadOnlyInWorker(
          { agentId: childAgentId, storePath, sessionKey },
          assertCurrent,
          async (result) => {
            if (!result.ok) {
              throw result.error;
            }
            return result.value?.sessionId;
          },
        ));
      if (!retainedSessionId || (cursorSessionId && cursorSessionId !== retainedSessionId)) {
        throw new Error("The task has no current readable transcript generation");
      }
      if (terminalSubagent && !task.runId) {
        throw new Error("The completed task has no recorded run");
      }
      const readScope = { agentId: childAgentId, storePath, sessionId: retainedSessionId };
      const run =
        terminalSubagent && task.runId
          ? {
              id: task.runId,
              maxBytes: resolveChatHistoryTailReadMaxBytes(MAX_TASK_HISTORY_BYTES - 16_384),
            }
          : undefined;
      const physical = await readSessionHistoryPageInWorker(
        {
          kind: "transcript-binding",
          params: { target: readScope, run },
        },
        opts.signal,
      );
      assertCurrent();
      const baseSessionKey = cronRun
        ? parseCronRunScopeSuffix(sessionKey).baseSessionKey
        : sessionKey;
      if (
        !physical ||
        (physical.sessionKey !== sessionKey && physical.sessionKey !== baseSessionKey)
      ) {
        throw new Error("The recorded task transcript is unavailable");
      }
      await handleChatHistoryRequest({
        ...opts,
        method: "chat.history",
        retainedTranscript: { sessionId: retainedSessionId, run, requireCurrentSession },
        params: {
          sessionKey: physical.sessionKey,
          ...(childAgentId ? { agentId: childAgentId } : {}),
          limit,
          offset,
          maxBytes: MAX_TASK_HISTORY_BYTES - 16_384,
        },
        respond: (ok, payload, error) => {
          assertCurrent();
          if (!ok) {
            respond(false, undefined, error);
            return;
          }
          const page = asOptionalRecord(payload);
          if (!Array.isArray(page?.messages)) {
            throw new Error("Task transcript returned no messages");
          }
          const result = {
            messages: page.messages,
            ...(page.activity ? { activity: page.activity } : {}),
            ...(page.hasMore === true && typeof page.nextOffset === "number"
              ? { nextCursor: `live:${JSON.stringify([retainedSessionId, page.nextOffset])}` }
              : {}),
          };
          if (!Value.Check(TasksHistoryResultSchema, result)) {
            throw new Error("Task transcript returned an invalid page");
          }
          publish(result);
        },
      });
    } else if (harness?.taskHistory) {
      publish(
        await harness.taskHistory.read({
          task,
          cfg: context.getRuntimeConfig(),
          cursor,
          limit,
          assertCurrent,
        }),
      );
    } else {
      fail("This task has no readable transcript.");
    }
  } catch (error) {
    if (error instanceof Error && error.message === TASK_ARCHIVE_RECORD_CAPACITY_ERROR) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Task history cannot be previewed because a retained transcript record exceeds the 8 MiB limit. Retained history is unchanged. Refreshing will not help.",
          {
            retryable: false,
            details: { code: GatewayErrorDetailCodes.TASK_HISTORY_PREVIEW_CAPACITY },
          },
        ),
      );
    } else {
      fail("Unable to load this task's transcript. Refresh the task and try again.");
    }
  } finally {
    active = false;
  }
};
