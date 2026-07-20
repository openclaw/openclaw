import { readSessionTranscriptVisibleMessageDelta } from "openclaw/plugin-sdk/session-transcript-runtime";

const PLUGIN_ID = "transcript-cursor-context-fixture";
const SNAPSHOT_METHOD = `${PLUGIN_ID}.snapshot`;
const SDK_MAX_BYTES = 16 * 1024 * 1024;
const SDK_MAX_MESSAGES = 5_000;
const stateKey = Symbol.for("openclaw.transcript-cursor-context-fixture.state");
const shared = (globalThis[stateKey] ??= {
  factoryCount: 0,
  lifecycle: { afterTurn: 0, assemble: 0, bootstrap: 0 },
  states: new Map(),
});
const states = shared.states;

function getState(sessionKey) {
  let state = states.get(sessionKey);
  if (!state) {
    state = {
      bootstrapCount: 0,
      count: 0,
      cursor: undefined,
      firstContent: undefined,
      firstEntryId: undefined,
      lastEntryId: undefined,
      maxEntriesPerPage: 0,
      maxSerializedBytes: 0,
      pageCount: 0,
      resetCount: 0,
      target: undefined,
    };
    states.set(sessionKey, state);
  }
  return state;
}

function resolveTarget(params) {
  const sessionId = params.sessionTarget?.sessionId ?? params.sessionId;
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey;
  if (!sessionId || !sessionKey) {
    throw new Error("cursor fixture requires a scoped session target");
  }
  return {
    sessionId,
    sessionKey,
    ...(params.sessionTarget?.agentId ? { agentId: params.sessionTarget.agentId } : {}),
    ...(params.sessionTarget?.storePath ? { storePath: params.sessionTarget.storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
      : {}),
  };
}

async function consume(params) {
  const target = resolveTarget(params);
  const state = getState(target.sessionKey);
  state.target = target;
  for (;;) {
    const result = await readSessionTranscriptVisibleMessageDelta({
      ...target,
      ...(state.cursor ? { cursor: state.cursor } : {}),
      maxBytes: SDK_MAX_BYTES,
      maxMessages: SDK_MAX_MESSAGES,
    });
    if (result.kind === "reset") {
      state.count = 0;
      state.cursor = result.cursor;
      state.firstContent = undefined;
      state.firstEntryId = undefined;
      state.lastEntryId = undefined;
      state.resetCount += 1;
      continue;
    }
    // Rebuild is a readiness signal, not a fatal plugin error. A later
    // lifecycle call or snapshot request resumes from the same cursor.
    if (result.kind === "unavailable") {
      return undefined;
    }
    if (result.kind !== "page") {
      throw new Error(`unexpected visible transcript result: ${result.kind}`);
    }
    state.pageCount += 1;
    state.maxEntriesPerPage = Math.max(state.maxEntriesPerPage, result.entries.length);
    state.maxSerializedBytes = Math.max(state.maxSerializedBytes, result.serializedBytes);
    for (const entry of result.entries) {
      state.firstContent ??= entry.message?.content;
      state.firstEntryId ??= entry.entryId;
      state.lastEntryId = entry.entryId;
      state.count += 1;
    }
    state.cursor = result.cursor;
    if (!result.hasMore) {
      return state;
    }
    if (result.entries.length === 0) {
      throw new Error("visible transcript cursor did not advance");
    }
  }
}

function snapshotState(state) {
  if (!state) {
    return null;
  }
  return {
    bootstrapCount: state.bootstrapCount,
    count: state.count,
    ...(state.firstContent !== undefined ? { firstContent: state.firstContent } : {}),
    ...(state.firstEntryId ? { firstEntryId: state.firstEntryId } : {}),
    hasCursor: Boolean(state.cursor),
    ...(state.lastEntryId ? { lastEntryId: state.lastEntryId } : {}),
    maxEntriesPerPage: state.maxEntriesPerPage,
    maxSerializedBytes: state.maxSerializedBytes,
    pageCount: state.pageCount,
    resetCount: state.resetCount,
  };
}

export default {
  id: PLUGIN_ID,
  register(api) {
    api.registerContextEngine(PLUGIN_ID, () => {
      shared.factoryCount += 1;
      return {
        info: { id: PLUGIN_ID, name: "Transcript cursor fixture", ownsCompaction: true },
        async bootstrap(params) {
          shared.lifecycle.bootstrap += 1;
          const state = await consume(params);
          if (state) {
            state.bootstrapCount += 1;
          }
          return { bootstrapped: Boolean(state), importedMessages: state?.count ?? 0 };
        },
        async ingest() {
          return { ingested: false };
        },
        async assemble(params) {
          shared.lifecycle.assemble += 1;
          return { messages: params.messages.slice(-2), estimatedTokens: 1 };
        },
        async compact() {
          return { ok: true, compacted: false, reason: "fixture does not compact" };
        },
        async afterTurn(params) {
          shared.lifecycle.afterTurn += 1;
          await consume(params);
        },
      };
    });
    api.registerGatewayMethod(SNAPSHOT_METHOD, async ({ params, respond }) => {
      const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : "";
      const state = states.get(sessionKey);
      if (state?.target) {
        await consume(state.target);
      }
      respond(true, {
        factoryCount: shared.factoryCount,
        lifecycle: shared.lifecycle,
        session: snapshotState(state),
      });
    });
  },
};
