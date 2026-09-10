import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTasksHistoryParams,
  type TasksHistoryResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { getTaskById } from "../../tasks/runtime-internal.js";
import { resolveTaskHistoryHarness, taskTranscriptSessionKey } from "../../tasks/task-history.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
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
  const task = getTaskById(params.taskId);
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
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Task not found."));
    return;
  }
  const binding = historyBinding(task);
  let cursor: string | undefined;
  try {
    cursor = decodeCursor(params.cursor, binding);
  } catch {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Invalid task history cursor. Refresh the task."),
    );
    return;
  }
  const sessionKey = taskTranscriptSessionKey(task);
  const harness = resolveTaskHistoryHarness(task);
  let active = true;
  const assertCurrent = () => {
    const current = getTaskById(task.taskId);
    if (
      !active ||
      opts.signal?.aborted ||
      !allowed(current) ||
      historyBinding(current) !== binding ||
      (!sessionKey && resolveTaskHistoryHarness(current) !== harness)
    ) {
      throw new Error("Task history access changed");
    }
  };
  const publish = (page: TasksHistoryResult) => {
    assertCurrent();
    const result: TasksHistoryResult = {
      messages: page.messages,
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
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Invalid task history cursor. Refresh the task."),
        );
        return;
      }
      const { chatHistoryHandlers } = await import("./chat-history-handler.js");
      assertCurrent();
      const childAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? task.agentId;
      await expectDefined(
        chatHistoryHandlers["chat.history"],
        "chat history handler",
      )({
        ...opts,
        params: {
          sessionKey,
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
          publish({
            messages: page.messages,
            ...(page.hasMore === true && typeof page.nextOffset === "number"
              ? { nextCursor: String(page.nextOffset) }
              : {}),
          });
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
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "This task has no readable transcript."),
      );
    }
  } catch {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Unable to load this task's transcript. Refresh the task and try again.",
      ),
    );
  } finally {
    active = false;
  }
};
