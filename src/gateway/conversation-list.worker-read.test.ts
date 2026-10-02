import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../test/helpers/sqlite-parent-observer.js";
import {
  listConversations,
  prepareConversationRegistryScope,
  readConversation,
  resolveCurrentSessionPrimaryConversation,
} from "../config/sessions/conversation-registry.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runGatewayConversationList } from "./conversation-list.js";

let state: OpenClawTestState;
let storePath: string;
const sessionKey = "agent:main:reef:channel:room";
const sessionId = "conversation-read-session";
const config = (): OpenClawConfig => ({
  agents: { entries: { main: { default: true }, other: {} } },
  session: { store: storePath },
});
const scope = () => ({ agentId: "main", storePath, sessionKey, sessionId });

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  storePath = state.statePath("shared-conversations.sqlite");
  openOpenClawAgentDatabase({ agentId: "physical-owner", path: storePath });
  replaceSessionEntrySync(scope(), {
    sessionId,
    updatedAt: 100,
    chatType: "channel",
    delivery: {
      kind: "external",
      route: {
        channel: "reef",
        accountId: "default",
        target: { to: "reef:room", chatType: "channel" },
      },
      context: { channel: "reef", accountId: "default", to: "reef:room" },
      origin: { provider: "reef", accountId: "default" },
    },
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => state.cleanup());

it("reads a shared store's list, exact address and primary binding without caller-thread SQLite", async () => {
  const observer = observeParentSqlite();
  try {
    const result = await runGatewayConversationList({
      config: config(),
      agentId: "main",
      limit: 10,
    });
    expect(result.conversations).toEqual([
      expect.objectContaining({ channel: "reef", target: "reef:room" }),
    ]);
    const ref = result.conversations[0]!.conversationRef;
    const exact = await readConversation(scope(), ref);
    expect(exact).toMatchObject({ conversationRef: ref, sessionId, sessionKey, role: "primary" });
    expect(await resolveCurrentSessionPrimaryConversation(scope())).toEqual(exact);
    const missing = state.statePath("absent", "openclaw-agent.sqlite");
    expect(await listConversations({ agentId: "main", storePath: missing })).toEqual([]);
    expect(observer.counts).toEqual(emptySqliteCounts());
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    observer.restore();
  }
});

it("rechecks current route ownership after the worker reply is delayed", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const run = historyLane.pool.run.bind(historyLane.pool);
  vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
    const reply = await run(...args);
    if (
      reply.ok &&
      typeof reply.value === "object" &&
      !Array.isArray(reply.value) &&
      "kind" in reply.value &&
      reply.value.kind === "conversation-rows"
    ) {
      entered.resolve();
      await release.promise;
    }
    return reply;
  });
  let current = config();
  const pending = runGatewayConversationList({
    config: current,
    readCurrentConfig: () => current,
    agentId: "main",
    limit: 10,
  });
  const outcome = pending.catch((error: unknown) => error);
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "Conversation read was not dispatched",
    );
    current = {
      ...current,
      bindings: [{ type: "route", agentId: "other", match: { channel: "reef" } }],
    };
    release.resolve();
    await expect(pending).resolves.toEqual({ conversations: [] });
  } finally {
    release.resolve();
    await outcome;
  }
});

it("propagates worker rejection without reading SQLite on the caller", async () => {
  const failure = new Error("conversation worker refused");
  vi.spyOn(historyLane.pool, "run").mockRejectedValueOnce(failure);
  const observer = observeParentSqlite();
  try {
    await expect(listConversations({ ...scope(), databaseAgentId: "physical-owner" })).rejects.toBe(
      failure,
    );
    expect(observer.counts).toEqual(emptySqliteCounts());
  } finally {
    observer.restore();
  }
});

it.each(["conversation-rows", "session-store-target"] as const)(
  "refuses a replaced source while %s is pending",
  async (phase) => {
    const directory = state.statePath(phase);
    const missing = state.statePath(phase, "openclaw-agent.sqlite");
    const locator =
      phase === "session-store-target" ? state.statePath(phase, "sessions.json") : missing;
    await fs.mkdir(directory, { recursive: true });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const run = historyLane.pool.run.bind(historyLane.pool);
    vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
      const reply = await run(...args);
      if (
        reply.ok &&
        typeof reply.value === "object" &&
        !Array.isArray(reply.value) &&
        "kind" in reply.value &&
        reply.value.kind === phase
      ) {
        entered.resolve();
        await release.promise;
      }
      return reply;
    });
    const pending = listConversations({ agentId: "main", storePath: locator });
    const outcome = pending.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Conversation read was not dispatched",
      );
      await fs.writeFile(missing, "replacement source");
      release.resolve();
      await expect(pending).rejects.toThrow(/Session store changed/);
    } finally {
      release.resolve();
      await outcome;
      await fs.unlink(missing).catch(() => {});
    }
  },
);

it("keeps process-held incognito conversations with their native owner", async () => {
  const native = {
    agentId: "main",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    sessionKey: "agent:main:dashboard:incognito-conversation-read",
    sessionId: "incognito-conversation-read",
  };
  replaceSessionEntrySync(native, {
    sessionId: native.sessionId,
    updatedAt: 100,
    chatType: "channel",
    delivery: {
      kind: "external",
      route: {
        channel: "reef",
        accountId: "default",
        target: { to: "reef:room", chatType: "channel" },
      },
      context: { channel: "reef", accountId: "default", to: "reef:room" },
      origin: { provider: "reef", accountId: "default" },
    },
  });
  const worker = vi.spyOn(historyLane.pool, "run");
  const prepared = await prepareConversationRegistryScope({
    agentId: "main",
    config: { session: { store: native.storePath } },
  });
  const rows = await listConversations(prepared);
  expect(rows).toEqual([
    expect.objectContaining({ sessionId: native.sessionId, sessionKey: native.sessionKey }),
  ]);
  expect(await resolveCurrentSessionPrimaryConversation(native)).toEqual(rows[0]);
  expect(worker).not.toHaveBeenCalled();
  await expect(fs.stat(native.storePath)).rejects.toMatchObject({ code: "ENOENT" });
});
