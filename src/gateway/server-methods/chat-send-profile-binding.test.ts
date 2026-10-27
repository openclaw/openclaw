import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createExpectedProfileBinding } from "../expected-profile.js";
import { expectRejectedOnce as expectRejected } from "../server-methods.request-gate.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import * as sessionSharingFacts from "../session-sharing-facts-read.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import {
  bindChatProfile,
  holdSessionWriter,
  observeChatReservation,
} from "./chat-send-admission-fixtures.test-support.js";
import { admitChatSend } from "./chat-send-admission.js";
import { prepareChatAdmission } from "./chat-send-admission.test-support.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();
type Fixture = Awaited<ReturnType<typeof createFixture>>;

function expectProfileMismatch(
  respond: unknown,
  execution: "not_started" | "may_have_executed" = "not_started",
) {
  expectRejected(respond, { details: { reason: "EXPECTED_PROFILE_MISMATCH", execution } });
}

async function expectNoInput(fixture: Fixture) {
  expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
  expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
}

function bindProfile(fixture: Fixture, native = false) {
  return bindChatProfile(fixture.client, "caller@example.test", native);
}

it.each([true, false])(
  "authorizes the default-scope global alias against main (allowed: %s)",
  async (mainAllowed) => {
    const fixture = await createFixture();
    const { successor: owner } = bindProfile(fixture);
    fixture.client.connect.scopes = ["operator.read", "operator.write"];
    fixture.params.sessionKey = "global";
    fixture.params.agentId = "main";
    const createdActor = { type: "human", source: "profile", id: owner.id } as const;
    await patchSessionEntryCore(fixture.scope, (entry) => ({
      ...entry,
      createdActor,
      visibility: mainAllowed ? "shared" : "draft",
    }));
    const literal = { ...fixture.scope, sessionKey: "global", sessionId: "literal-global" };
    await replaceSessionEntry(literal, {
      sessionId: literal.sessionId,
      updatedAt: 1,
      createdActor,
      visibility: mainAllowed ? "draft" : "shared",
    });
    const projection = await createSessionRowProjection({
      cfg: fixture.context.getRuntimeConfig(),
      modelCatalog: [],
    });
    bindSessionRowProjection(fixture.context, () => projection);
    try {
      const respond = await fixture.send(undefined, {});
      if (mainAllowed) {
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        await fixture.dispatchedRecorder;
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
          total: 1,
          items: [{ runId: fixture.params.idempotencyKey }],
        });
      } else {
        expectRejected(respond, {
          code: "INVALID_REQUEST",
          details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
        });
        expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      }
      expect(await listSessionPendingInputs(literal)).toEqual({ items: [], total: 0 });
      expect(loadTranscriptEventsSync(literal)).toEqual([]);
    } finally {
      await fixture.cleanup();
      projection.dispose();
      await projection.ensureMaterialized();
    }
  },
);

it("rejects caller replacement during initial authorization without an expected profile", async () => {
  await using fixture = await createFixture();
  const { successor: replacement } = bindProfile(fixture);
  const entered = createDeferred();
  const release = createDeferred();
  const read = sessionSharingFacts.readSessionSharingFactsInWorker;
  let held = false;
  const sharingRead = vi
    .spyOn(sessionSharingFacts, "readSessionSharingFactsInWorker")
    .mockImplementation(async (input, prepareSource) => {
      const result = await read(input, prepareSource);
      if (!held && input.sessionKeys.includes(fixture.scope.sessionKey)) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    });
  const request = fixture.send(undefined, {});
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      request,
      "chat.send settled before its initial authorization read",
    );
    expect(fixture.context.dedupe.size).toBe(0);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    setClientProfile(fixture.client, replacement);
    release.resolve();
    const respond = await request;
    expectRejected(respond, {
      code: "FORBIDDEN",
      message: "Gateway requester authority changed",
    });
    expect(fixture.context.dedupe.size).toBe(0);
    expect(getRpcSource(fixture.params.idempotencyKey)).toBeUndefined();
    await expectNoInput(fixture);
  } finally {
    release.resolve();
    sharingRead.mockRestore();
    await request;
  }
});

it.each(["reservation", "writer", "approval"] as const)(
  "rejects a native account merge at %s without accepting or terminalizing input",
  async (boundary) => {
    await using fixture = await createFixture();
    const runId = fixture.params.idempotencyKey;
    const { profile: source, merge } = bindProfile(fixture, true);
    const before = loadSessionEntry(fixture.scope);
    let writer: ReturnType<typeof holdSessionWriter> | undefined;
    let request: ReturnType<typeof fixture.send> | undefined;
    try {
      if (boundary === "reservation") {
        const prepared = await prepareChatAdmission(fixture);
        const binding = (await createExpectedProfileBinding(source.id, fixture.client))!;
        binding.markInvoked();
        merge();
        await expect(
          admitChatSend({
            ...prepared,
            respond: vi.fn(),
            assertCurrent: binding.assertCurrent,
          }),
        ).rejects.toMatchObject({
          error: {
            details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
          },
        });
        expect(fixture.context.dedupe.size).toBe(0);
      } else {
        if (boundary === "writer") {
          writer = holdSessionWriter(fixture.scope.storePath);
          await writer.entered;
          {
            using reservation = observeChatReservation(fixture.context, runId);
            request = fixture.send(undefined, { expectedProfileId: source.id });
            await reservation.wait(request);
            expect(fixture.context.dedupe.has(reservation.key)).toBe(true);
          }
          merge();
          writer.release();
          await writer.finished;
        } else {
          fixture.beforeApprove.mockImplementation(merge);
          request = fixture.send(undefined, { expectedProfileId: source.id });
        }
        const respond = await request;
        expectProfileMismatch(respond, "may_have_executed");
      }
      expect(loadSessionEntry(fixture.scope)).toEqual(before);
      await expectNoInput(fixture);
      expect(rpcSourceTesting.size).toBe(0);
      const cached = fixture.context.dedupe.get(`chat:${runId}`);
      expect([cached?.payload, cached?.error]).toEqual([undefined, undefined]);
    } finally {
      writer?.release();
      await writer?.finished;
      await request;
    }
  },
);

it("terminalizes a native command account merge during fresh transcript approval without rewriting the ACK", async () => {
  await using fixture = await createFixture({ persistDuringDispatch: true });
  const runId = fixture.params.idempotencyKey;
  fixture.params.message = "/context list";
  const { profile: source, merge } = bindProfile(fixture, true);
  const ack = await fixture.send(undefined, { expectedProfileId: source.id });
  expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
  const recorder = await fixture.dispatchedRecorder;
  const acceptedAck = structuredClone(ack.mock.calls);
  fixture.beforeApprove.mockImplementation(merge);
  await fixture.finishDispatch();
  expect.soft(recorder.getAdmissionReceipt()).toBeUndefined();
  expect.soft(ack.mock.calls).toEqual(acceptedAck);
  expect.soft(ack).toHaveBeenCalledOnce();
  const transcript = loadTranscriptEventsSync(fixture.scope);
  expect
    .soft(transcript.filter((entry) => isRecord(entry) && entry.type === "message"))
    .toEqual(
      fixture.activeTranscript.filter((entry) => isRecord(entry) && entry.type === "message"),
    );
  expect.soft(transcript).toContainEqual(
    expect.objectContaining({
      type: "custom_message",
      customType: "run-failed-before-reply",
      display: true,
      details: expect.objectContaining({ runId }),
    }),
  );
  expect
    .soft(loadSessionEntry(fixture.scope))
    .toMatchObject({ status: "failed", lastRunId: runId });
  expect.soft(fixture.context.dedupe.get(`chat:${runId}`)).toMatchObject({
    ok: false,
    payload: { runId, status: "error" },
    error: { message: expect.stringContaining("Selected account changed") },
  });
  expect.soft(fixture.context.broadcast).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({
      runId,
      state: "error",
      errorMessage: expect.stringContaining("Selected account changed"),
    }),
    expect.anything(),
  );
  expect.soft(rpcSourceTesting.size).toBe(0);
  expect.soft(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
});

it("preserves accepted native input across profile merge without adopting the retry socket", async () => {
  await using fixture = await createFixture();
  const runId = fixture.params.idempotencyKey;
  const { profile, merge } = bindProfile(fixture);
  fixture.client.connect.client = {
    id: "openclaw-macos",
    version: "test",
    platform: "darwin",
    mode: "ui",
  };
  const ack = await fixture.send(undefined, {
    expectedProfileId: profile.id,
  });
  expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
  const recorder = await fixture.dispatchedRecorder;
  const committed = await recorder.persistApproved();
  expect(committed).toMatchObject({ appended: true });
  const receipt = recorder.getAdmissionReceipt();
  expect(receipt).toBeDefined();
  const accepted = loadTranscriptEventsSync(fixture.scope);
  expect(accepted).toHaveLength(fixture.activeTranscript.length + 1);
  expect(accepted.at(-1)).toMatchObject({ message: { content: fixture.approvedContent } });
  const owner = rpcSourceTesting.get(runId);
  expect(owner).toBeDefined();
  const ownerConnId = owner?.adapter.requester?.connectionId;
  const cached = structuredClone(fixture.context.dedupe.get(`chat:${runId}`));
  fixture.client.connId = "native-reconnected";
  merge();
  const retry = await fixture.send(undefined, { expectedProfileId: profile.id });
  expectProfileMismatch(retry);
  expect(rpcSourceTesting.get(runId)).toBe(owner);
  expect(owner).toMatchObject({
    adapter: { requester: { connectionId: ownerConnId } },
    input: { abortSignal: { aborted: false } },
  });
  const retained = () => [loadTranscriptEventsSync(fixture.scope), recorder.getAdmissionReceipt()];
  expect(retained()).toEqual([accepted, receipt]);
  expect(fixture.context.dedupe.get(`chat:${runId}`)).toEqual(cached);
  expect(await recorder.persistApproved()).toEqual(committed);
  expect(retained()).toEqual([accepted, receipt]);
  expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
  expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
});

it.each(["host", "session ACL", "lifecycle"] as const)(
  "retains original %s authority after committed browser custody and profile merge",
  async (boundary) => {
    await using fixture = await createFixture({
      preserveContent: true,
      persistDuringDispatch: true,
    });
    const runId = fixture.params.idempotencyKey;
    let hostCurrent = true;
    const { profile, merge } = bindProfile(fixture);
    if (boundary === "session ACL") {
      fixture.client.connect.scopes = ["operator.read", "operator.write"];
    }
    const ack = await fixture.send(undefined, {
      expectedProfileId: profile.id,
      sessionMutationCommitGuard: () => {
        if (!hostCurrent) {
          throw new Error("The original input host has closed.");
        }
      },
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
    const originalAck = structuredClone(ack.mock.calls);
    const pending = await listSessionPendingInputs(fixture.scope);
    expect(pending).toMatchObject({
      total: 1,
      items: [{ state: "queued", message: { content: fixture.params.message } }],
    });
    await fixture.dispatchedRecorder;
    merge();
    if (boundary === "host") {
      hostCurrent = false;
    } else if (boundary === "session ACL") {
      await patchSessionEntryCore(fixture.scope, () => ({ visibility: "draft" }));
    } else {
      rotateAgentEventLifecycleGeneration();
    }
    await fixture.finishDispatch();
    expect(ack.mock.calls).toEqual(originalAck);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(
      loadTranscriptEventsSync(fixture.scope).filter(
        (entry) =>
          isRecord(entry) &&
          entry.type === "message" &&
          isRecord(entry.message) &&
          entry.message.idempotencyKey === `${runId}:user`,
      ),
    ).toEqual([]);
    expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
      total: 1,
      items: [
        {
          id: pending.items[0]?.id,
          state: "interrupted",
          message: pending.items[0]?.message,
        },
      ],
    });
    const cached = structuredClone(fixture.context.dedupe.get(`chat:${runId}`));
    expect(cached).toMatchObject({ ok: false, payload: { runId, status: "error" } });
    expect(fixture.context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId, state: "error", errorMessage: expect.any(String) }),
      expect.anything(),
    );
    const retry = await fixture.send(undefined, { expectedProfileId: profile.id });
    expectProfileMismatch(retry);
    expect(fixture.context.dedupe.get(`chat:${runId}`)).toEqual(cached);
    expect(rpcSourceTesting.size).toBe(0);
  },
);
