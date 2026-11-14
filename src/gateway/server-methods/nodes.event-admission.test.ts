import assert from "node:assert/strict";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../../test/helpers/promise.js";
import { createMemorySessionActorOwner } from "../../config/sessions/session-actor-memory.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { buildNodeEventContext, runtimeMocks } from "../server-node-events.test-support.js";
import { nodeEventHandlers } from "./nodes.event.js";
import { NodeEventHarness } from "./nodes.event.test-support.js";

// The handler fixture installs broad module mocks; keep it out of the MCP authority suite.
afterEach(() => vi.restoreAllMocks());

it.each([
  { message: "x".repeat(20_001), reason: "message_too_large", handled: false },
  { message: "x".repeat(20_000), reason: "accepted", handled: true },
  {
    message: "read this",
    attachments: [
      { type: "file", mimeType: "application/pdf", fileName: "a.pdf", content: "JVBERi0=" },
    ],
    reason: "invalid_attachments",
    handled: false,
  },
])("reports agent request admission through node.event ($reason)", async (scenario) => {
  const { parseMessageWithAttachments } =
    await vi.importActual<typeof import("../chat-attachments.js")>("../chat-attachments.js");
  runtimeMocks.parseMessageWithAttachments.mockImplementation(parseMessageWithAttachments);
  runtimeMocks.persistInboundImagesForTranscript.mockResolvedValue({
    entries: [],
    omission: "none",
  });
  const work = createDeferred();
  runtimeMocks.agentCommandFromIngress.mockReset().mockReturnValue(work.promise);
  const h = new NodeEventHarness();
  Object.assign(h.context, buildNodeEventContext(), { logGateway: { warn: h.warn } });
  const client = h.register("share-connection", "share-node", "openclaw-ios", "ios");
  try {
    const respond = await h.send(
      client,
      {
        message: scenario.message,
        sessionKey: "agent:main:share-admission",
        attachments: scenario.attachments,
      },
      "agent.request",
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      {
        ok: true,
        event: "agent.request",
        handled: scenario.handled,
        reason: scenario.reason,
      },
      undefined,
    );
    if (scenario.handled) {
      expect(runtimeMocks.agentCommandFromIngress).toHaveBeenCalledOnce();
      expect(runtimeMocks.agentCommandFromIngress.mock.calls[0]?.[0]).toMatchObject({
        message: scenario.message,
      });
    } else {
      expect(runtimeMocks.agentCommandFromIngress).not.toHaveBeenCalled();
    }
  } finally {
    work.resolve();
  }
});

it("admits an incognito share before the agent finishes and retains its actor custody", async () => {
  const sessionKey = "agent:main:dashboard:incognito-share-admission";
  const location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: "/synthetic-share-state" },
    }),
  };
  const owner = createMemorySessionActorOwner(location);
  onTestFinished(() => owner.close());
  const authority = { assertCurrent() {}, assertReadable() {}, authorize() {} };
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, authority);
  onTestFinished(() => actor.release());
  assert(actor.storage);
  await actor.storage.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: { sessionId: "private-share", updatedAt: 1, incognito: true },
      },
    },
    authority,
  );
  runtimeMocks.persistInboundImagesForTranscript.mockResolvedValue({
    entries: [],
    omission: "none",
  });
  runtimeMocks.upsertSessionEntryCore.mockImplementation(async (_scope, patch) => patch);
  const work = createDeferred();
  const dispatched = createDeferred();
  runtimeMocks.agentCommandFromIngress.mockReset().mockImplementation(async () => {
    dispatched.resolve();
    await work.promise;
    // Resume after the admission response, through the binding inherited by accepted work.
    const retained = getSessionActorStorageBinding({ sessionKey });
    assert(retained);
    const result = await retained.actor.storage.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { label: "Written after admission" } } },
      },
      retained.authority,
    );
    expect(result.kind).toBe("committed");
  });
  const h = new NodeEventHarness();
  Object.assign(h.context, buildNodeEventContext());
  const client = h.register("private-share-connection");
  const respond = vi.fn();
  const params = { event: "agent.request", payload: { sessionKey, message: "private share" } };
  let finished = false;
  const done = runWithSessionActorStorage({ actor, authority, ...location }, async () =>
    nodeEventHandlers["node.event"]!({
      req: { type: "req", id: "private-share", method: "node.event", params },
      params,
      context: h.context,
      client,
      respond,
      isWebchatConnect: () => false,
    }),
  ).then(() => {
    finished = true;
  });
  try {
    await dispatched.promise;
    await nextEventLoopTurn();
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      {
        ok: true,
        event: "agent.request",
        handled: true,
        reason: "accepted",
      },
      undefined,
    );
    expect(finished).toBe(false);
  } finally {
    work.resolve();
    await done;
    expect(
      actor.storage.readCurrent({ type: "session.entry.read", input: { sessionKey } }, authority),
    ).toMatchObject({ sessionId: "private-share", label: "Written after admission" });
  }
  expect(respond).toHaveBeenCalledTimes(1);
});
