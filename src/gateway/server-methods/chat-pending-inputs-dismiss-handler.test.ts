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
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
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
  const stage = async (runId: string, disposition?: "interrupted" | "cancelled") => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope, {
        runId,
        message: {
          role: "user",
          content: `Synthetic retained prompt ${runId}`,
          timestamp: 1,
          idempotencyKey: `${runId}:user`,
        },
        requestFingerprint: "e".repeat(64),
        assertCurrent: () => {},
      }),
      "accepted input",
    );
    receipts.push(receipt);
    if (disposition) {
      receipt.finish(disposition);
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
      f.receipts.forEach((receipt) => receipt.finish("cancelled"));
      await Promise.all(f.receipts.map(async (receipt) => receipt.settled?.()));
      await disposeSessionReadContexts();
    }
  });
}

it("tombstones retired inputs, returns their run ids, and keeps every row", () =>
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
    for (const [id, state] of [
      [f.interrupted, "interrupted"],
      [f.cancelled, "cancelled"],
    ] as const) {
      const item = items.find((candidate) => candidate.id === id);
      expect(item?.state).toBe(state);
      expect(item?.message.display).toBeUndefined();
      expect(JSON.stringify(item?.message.content)).toContain("Synthetic retained prompt");
    }
    const changed = vi.spyOn(sessionChangeEvent, "emitSessionsChanged");
    expect(await f.dismiss([f.interrupted, f.cancelled, "gone-input"])).toEqual([
      true,
      {
        dismissedIds: [f.interrupted, f.cancelled],
        runIds: ["interrupted", "cancelled"],
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
      [f.interrupted]: "cancelled:hidden",
      [f.cancelled]: "cancelled:hidden",
    });
    const [ok, history] = await chatRpc(f.context, f.client, "chat.history", {
      sessionKey: scope.sessionKey,
      inputRunIds: ["interrupted"],
    });
    expect(ok).toBe(true);
    const page = history as {
      pendingInputs: { items: { id: string; message: Record<string, unknown> }[] };
      inputReceipts: unknown[];
    };
    expect(page.inputReceipts).toEqual([
      { runId: "interrupted", state: "pending", cancelled: true },
    ]);
    expect(page.pendingInputs.items.find((item) => item.id === f.interrupted)?.message).toEqual(
      expect.objectContaining({ display: false, content: [] }),
    );
  }));

it("refuses queued inputs with a structured error and emits no change", () =>
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

it("refuses at the worker commit when session write access is revoked after admission", () =>
  withDismissTest(async (f) => {
    const changed = vi.spyOn(sessionChangeEvent, "emitSessionsChanged");
    const before = await f.retained();
    const admitted = probe.admission(admission, (request, grant, callback) => {
      if (request.stage === "commit") {
        f.client.connect.scopes = ["operator.read"];
      }
      return callback(request, grant);
    });
    try {
      expect(await f.dismiss([f.interrupted, f.cancelled])).toMatchObject(forbidden);
    } finally {
      admitted.mockRestore();
    }
    expect(changed).not.toHaveBeenCalled();
    expect(await f.retained()).toEqual(before);
  }));
