import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  ErrorCodes,
  errorShape,
  validateCronHistoryParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CronHistoryResultSchema } from "../../../packages/gateway-protocol/src/schema/cron.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionHistoryPageInWorker } from "../../config/sessions/session-history-worker-runtime.js";
import { cronRunRecordToRunLogEntry } from "../../cron/run-history-detail.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { readCronRunRecords } from "../../cron/store/read-only.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import { cronJobMatchesCallerScope, readCronCallerScope } from "./cron-caller-scope.js";
import { assertCronReadCurrent } from "./cron-job-access.js";
import {
  createCronSessionVisibility,
  cronJobIsVisible,
  cronJobVisibilityTarget,
} from "./cron-visibility.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_CRON_HISTORY_BYTES = 4 * 1024 * 1024;

export const cronHistoryHandler: GatewayRequestHandler = async (opts) => {
  const { params, respond, context, client } = opts;
  if (!assertValidParams(params, validateCronHistoryParams, "cron.history", respond)) {
    return;
  }
  if (!params.runId && params.runAtMs === undefined) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "cron.history requires an id and exact runId or runAtMs",
      ),
    );
    return;
  }
  const fail = () =>
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "The recorded cron transcript is unavailable. Refresh the run and try again.",
      ),
    );
  const storeKey = cronStoreKey(context.cronStorePath);
  const sessionVisibility = createCronSessionVisibility(client, () => context.getRuntimeConfig());
  const assertAllowed = (sessionKey?: string, agentId?: string) => {
    assertCronReadCurrent(opts);
    const callerScope = readCronCallerScope(client);
    const visibility = sessionVisibility.resolve();
    const job = context.cron.getJob(params.id);
    const defaultAgentId = context.cron.getDefaultAgentId();
    if (
      (callerScope || visibility) &&
      (!job ||
        !cronJobMatchesCallerScope({ job, callerScope, defaultAgentId, allowCurrentJob: true }) ||
        !cronJobIsVisible(job, visibility, defaultAgentId))
    ) {
      throw new Error("Cron job not found");
    }
    if (sessionKey && visibility && !visibility(sessionKey, agentId)) {
      throw new Error("Cron transcript not found");
    }
  };
  try {
    await context.cron.readJob(params.id);
    assertCronReadCurrent(opts);
    await sessionVisibility.prepare([
      cronJobVisibilityTarget(context.cron.getJob(params.id), context.cron.getDefaultAgentId()),
    ]);
    assertAllowed();
    const select = async () =>
      (await readCronRunRecords(storeKey, params.id)).flatMap((record) => {
        const entry = cronRunRecordToRunLogEntry(record);
        return entry &&
          (!params.runId || entry.runId === params.runId) &&
          (params.runAtMs === undefined || entry.runAtMs === params.runAtMs)
          ? [{ record, entry }]
          : [];
      });
    const matches = await select();
    assertAllowed();
    const selected = matches.length === 1 ? matches[0] : undefined;
    const sessionKey = selected?.entry.sessionKey;
    const sessionId = selected?.entry.sessionId;
    if (!selected || !sessionKey || !sessionId) {
      fail();
      return;
    }
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? selected.record.agentId;
    const bindingFor = (value: typeof selected) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            storeKey,
            value.record.id,
            value.record.runId,
            value.entry.jobId,
            value.entry.runId,
            value.entry.runAtMs,
            value.entry.sessionKey,
            value.entry.sessionId,
            value.record.agentId,
          ]),
        )
        .digest("base64url");
    const binding = bindingFor(selected);
    let offset = 0;
    if (params.cursor) {
      const cursor: unknown = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8"));
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        cursor[0] !== binding ||
        !Number.isSafeInteger(cursor[1]) ||
        cursor[1] < 0
      ) {
        throw new Error("Invalid cron history cursor");
      }
      offset = cursor[1];
    }
    const scope = {
      agentId,
      sessionId,
      storePath: resolveSessionStorePathCore(context.getRuntimeConfig().session?.store, {
        agentId,
      }),
    };
    const assertCurrent = (transcriptSessionKey?: string) => {
      if (
        cronStoreKey(context.cronStorePath) !== storeKey ||
        resolveSessionStorePathCore(context.getRuntimeConfig().session?.store, { agentId }) !==
          scope.storePath
      ) {
        throw new Error("Cron history store changed");
      }
      assertAllowed(transcriptSessionKey, agentId);
    };
    assertCurrent();
    const physical = await readSessionHistoryPageInWorker(
      {
        kind: "transcript-binding",
        params: { target: scope },
      },
      opts.signal,
    );
    assertCurrent();
    const { baseSessionKey } = parseCronRunScopeSuffix(sessionKey);
    if (
      !physical ||
      (physical.sessionKey !== sessionKey && physical.sessionKey !== baseSessionKey)
    ) {
      fail();
      return;
    }
    await sessionVisibility.prepare([{ sessionKey: physical.sessionKey, agentId }]);
    assertCurrent(physical.sessionKey);
    const { handleChatHistoryRequest } = await import("./chat-history-handler.js");
    assertCurrent(physical.sessionKey);
    await handleChatHistoryRequest({
      ...opts,
      method: "chat.history",
      retainedTranscript: {
        sessionId,
        verifyRetainedState: async () => {
          await context.cron.readJob(params.id);
          assertCurrent(physical.sessionKey);
          const current = await select();
          assertCurrent(physical.sessionKey);
          return current.length === 1 && bindingFor(current[0]!) === binding;
        },
      },
      params: {
        sessionKey: physical.sessionKey,
        ...(agentId ? { agentId } : {}),
        limit: params.limit ?? 100,
        offset,
        maxBytes: MAX_CRON_HISTORY_BYTES - 16_384,
      },
      respond: (ok, payload, error) => {
        if (!ok) {
          respond(false, undefined, error);
          return;
        }
        const page = asOptionalRecord(payload);
        const result = {
          messages: page?.messages,
          ...(page?.activity ? { activity: page.activity } : {}),
          ...(page?.hasMore === true && typeof page.nextOffset === "number"
            ? {
                nextCursor: Buffer.from(JSON.stringify([binding, page.nextOffset])).toString(
                  "base64url",
                ),
              }
            : {}),
        };
        if (
          !Value.Check(CronHistoryResultSchema, result) ||
          Buffer.byteLength(JSON.stringify(result)) > MAX_CRON_HISTORY_BYTES
        ) {
          throw new Error("Invalid cron transcript page");
        }
        // The shared retained-transcript owner still holds current sharing facts here.
        assertCurrent(physical.sessionKey);
        respond(true, result);
      },
    });
  } catch {
    fail();
  } finally {
    sessionVisibility.release();
  }
};
