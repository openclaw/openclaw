import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import * as sessionChangeEvent from "./session-change-event.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:pending-dismiss",
  sessionId: "pending-dismiss-session",
};
const forbidden = [false, undefined, { code: "FORBIDDEN" }];

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture() {
  const cfg: OpenClawConfig = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  const client = roleClient("write", "dismiss-owner");
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    createdActor: {
      type: "human",
      source: "profile",
      id: expectDefined(client.authenticatedUserProfile, "profile").profileId,
    },
  });
  const receipts: SessionPendingInputReceipt[] = [];
  const stage = async (
    runId: string,
    disposition?: "interrupted" | "cancelled",
    authorId?: string,
    content?: string,
  ) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope, {
        runId,
        message: {
          role: "user",
          content: content ?? `Synthetic retained prompt ${runId}`,
          timestamp: 1,
          idempotencyKey: `${runId}:user`,
          ...(authorId
            ? {
                __openclaw: {
                  requesterOrigin: { sessionKey: scope.sessionKey, operatorProfileId: authorId },
                  participationRevoked: true,
                },
              }
            : {}),
        },
        requestFingerprint: "e".repeat(64),
        assertCurrent: () => {},
      }),
      "accepted input",
    );
    receipts.push(receipt);
    if (disposition) {
      receipt.finish(disposition, authorId ? "revoked" : "failed");
      await receipt.settled?.();
    }
    return receipt.inputId;
  };
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  const queued = await stage("queued");
  const interrupted = await stage("interrupted", "interrupted");
  const cancelled = await stage("cancelled", "cancelled");
  return {
    client,
    stage,
    context,
    receipts,
    queued,
    interrupted,
    cancelled,
    retained: async () =>
      Object.fromEntries(
        (await listSessionPendingInputs(scope)).items.map((item) => [
          item.id,
          `${item.state}${item.message.display === false ? ":hidden" : ""}`,
        ]),
      ),
    dismiss: (inputIds: string[], params: Record<string, unknown> = {}, caller = client) =>
      chatRpc(context, caller, "chat.pendingInputs.dismiss", {
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        inputIds,
        ...params,
      }),
  };
}

async function withDismissTest(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const f = await fixture();
    try {
      await run(f);
    } finally {
      f.receipts.forEach((receipt) => receipt.finish("cancelled", "failed"));
      await Promise.all(f.receipts.map(async (receipt) => receipt.settled?.()));
      await disposeSessionReadContexts();
    }
  });
}

it("hides cancelled inputs and leaves legacy interrupted input inert", () =>
  withDismissTest(async (f) => {
    const [visible, originalHistory] = await chatRpc(f.context, f.client, "chat.history", {
      sessionKey: scope.sessionKey,
    });
    expect(visible).toBe(true);
    const items = (
      originalHistory as {
        pendingInputs: { items: { id: string; state: string; message: Record<string, unknown> }[] };
      }
    ).pendingInputs.items;
    expect(items.find((candidate) => candidate.id === f.interrupted)).toBeUndefined();
    const item = items.find((candidate) => candidate.id === f.cancelled);
    expect(item?.state).toBe("cancelled");
    expect(item?.message.display).toBeUndefined();
    expect(JSON.stringify(item?.message.content)).toContain("Synthetic retained prompt");
    const changed = vi.spyOn(sessionChangeEvent, "emitSessionsChanged");
    expect(await f.dismiss([f.cancelled, "gone-input"])).toEqual([
      true,
      {
        dismissedIds: [f.cancelled],
        runIds: ["cancelled"],
        missingIds: ["gone-input"],
      },
    ]);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0]?.[1]).toMatchObject({
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
    });
    expect(await f.retained()).toEqual({
      [f.queued]: "queued",
      [f.cancelled]: "cancelled:hidden",
    });
    const [ok, history] = await chatRpc(f.context, f.client, "chat.history", {
      sessionKey: scope.sessionKey,
      inputRunIds: ["cancelled"],
    });
    expect(ok).toBe(true);
    const page = history as {
      pendingInputs: { items: { id: string; message: Record<string, unknown> }[] };
      inputReceipts: unknown[];
    };
    expect(page.inputReceipts).toEqual([{ runId: "cancelled", state: "pending", cancelled: true }]);
    expect(
      page.pendingInputs.items.find((pending) => pending.id === f.interrupted),
    ).toBeUndefined();
    expect(page.pendingInputs.items.find((pending) => pending.id === f.cancelled)?.message).toEqual(
      expect.objectContaining({ display: false, content: [] }),
    );
  }));

it("refuses queued and legacy interrupted inputs with no change", () =>
  withDismissTest(async (f) => {
    const changed = vi.spyOn(sessionChangeEvent, "emitSessionsChanged");
    const before = await f.retained();
    expect(await f.dismiss([f.queued, f.cancelled])).toMatchObject([
      false,
      undefined,
      {
        code: "INVALID_REQUEST",
        details: { code: "PENDING_INPUT_NOT_RETIRED", inputIds: [f.queued] },
      },
    ]);
    expect(await f.dismiss([f.interrupted])).toMatchObject([
      false,
      undefined,
      {
        code: "INVALID_REQUEST",
        details: { code: "PENDING_INPUT_NOT_RETIRED", inputIds: [f.interrupted] },
      },
    ]);
    expect((await f.dismiss([f.cancelled], { sessionId: "replaced-session" }))[2]).toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(changed).not.toHaveBeenCalled();
    expect(await f.retained()).toEqual(before);
  }));

it("requires session write authority at the registered RPC", () =>
  withDismissTest(async (f) => {
    const before = await f.retained();
    for (const role of ["view", "none"] as const) {
      expect((await f.dismiss([f.cancelled], {}, roleClient(role, `dismiss-${role}`)))[0]).toBe(
        false,
      );
    }
    const readOnly = { ...f.client, connect: { ...f.client.connect, scopes: ["operator.read"] } };
    expect(await f.dismiss([f.cancelled], {}, readOnly)).toMatchObject(forbidden);
    const otherWriter = roleClient("write", "dismiss-other-writer");
    otherWriter.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    expect(await f.dismiss([f.cancelled], {}, otherWriter)).toMatchObject(forbidden);
    expect(await f.retained()).toEqual(before);
    f.client.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    expect((await f.dismiss([f.cancelled]))[0]).toBe(true);
  }));

it("retains revoked input for its author alone after session access is removed", () =>
  withDismissTest(async (f) => {
    const author = roleClient("none", "revoked-author");
    const other = roleClient("none", "other-author");
    const authorId = expectDefined(author.authenticatedUserProfile, "author").profileId;
    const originalText = "Synthetic retained prompt private-queued-text".repeat(400);
    const id = await f.stage("private-queued-text", "cancelled", authorId, originalText);
    const own = (caller = author, inputIds?: string[]) =>
      chatRpc(f.context, caller, "chat.pendingInputs.own", {
        sessionKey: scope.sessionKey,
        agentId: scope.agentId,
        ...(inputIds ? { inputIds } : {}),
      });
    expect(
      (await chatRpc(f.context, author, "chat.history", { sessionKey: scope.sessionKey }))[0],
    ).toBe(false);
    const response = await own();
    const [ok, result] = response;
    expect(ok, JSON.stringify(response)).toBe(true);
    expect(result).toMatchObject({
      sessionId: scope.sessionId,
      pendingInputs: { total: 1, items: [{ id, state: "cancelled", endCause: "revoked" }] },
    });
    expect(JSON.stringify(result)).toContain("Synthetic retained prompt private-queued-text");
    expect(
      await chatRpc(f.context, author, "chat.pendingInputs.own", {
        sessionKey: scope.sessionKey,
        inputId: id,
      }),
    ).toEqual([true, { text: originalText }]);
    expect(
      await chatRpc(f.context, other, "chat.pendingInputs.own", {
        sessionKey: scope.sessionKey,
        inputId: id,
      }),
    ).toEqual([true, { text: null }]);
    expect(result).not.toHaveProperty("messages");
    expect(result).not.toHaveProperty("sessionInfo");
    expect(await own(other, [id])).toEqual([
      true,
      { pendingInputs: { items: [], total: 0, queuedCount: 0 } },
    ]);
    const [, shared] = await chatRpc(f.context, f.client, "chat.history", {
      sessionKey: scope.sessionKey,
    });
    expect(JSON.stringify(shared)).not.toContain("private-queued-text");
    expect(
      await chatRpc(f.context, f.client, "chat.message.get", {
        sessionKey: scope.sessionKey,
        messageId: `pending:${id}`,
      }),
    ).toEqual([true, { ok: false, unavailableReason: "not_found" }]);
    const changed = vi.spyOn(sessionChangeEvent, "emitSessionsChanged");
    expect(await own(author, [id])).toEqual([
      true,
      { pendingInputs: { items: [], total: 0, queuedCount: 0 } },
    ]);
    expect(changed).not.toHaveBeenCalled();
    expect((await f.retained())[id]).toBe("cancelled:hidden");
    expect(await own()).toEqual([true, { pendingInputs: { items: [], total: 0, queuedCount: 0 } }]);
  }));
