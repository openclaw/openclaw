import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  updateSessionControllerSourcePolicy,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import { prepareInternalGetReplyOptions } from "./get-reply.types.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  bindReplySourceInput,
  bindReplySourceToFollowup,
  prepareReplySourceInput,
  readReplySourceInput,
  retireUnadoptedReplySource,
  retargetReplySourceForExecution,
} from "./reply-source-binding.js";

afterEach(() => testing.resetSessionControllerForTest());

const key = "agent:main:source-binding";
const target = captureSessionTarget({ storeScope: "/test/source.sqlite", sessionKey: key });
function reserve() {
  return reserveSessionControllerSource(key, { target, policy: { mode: "followup" } });
}
function prepare(sessionKey = key, store = "/test/source.sqlite", commandTarget?: string) {
  return prepareReplySourceInput(
    { SessionKey: sessionKey, CommandTargetSessionKey: commandTarget },
    { session: { store } },
    undefined,
  );
}

it("carries the Gateway source through lifecycle/options spreads to the actual followup", () => {
  const input = reserve();
  const lifecycle: TurnAdoptionLifecycle = bindReplySourceInput({ onAdopted() {} }, input);
  const options = prepareInternalGetReplyOptions({
    turnAdoptionLifecycle: { ...lifecycle, onAdopted: async () => lifecycle.onAdopted() },
  });
  const prepared = prepareReplySourceInput({ SessionKey: key }, {}, { ...options });
  const run = createQueueTestRun({ prompt: "hello" });
  expect(prepared.created).toBe(false);
  expect(readReplySourceInput(prepared.options)).toBe(input);
  bindReplySourceToFollowup({ ...prepared.options }, run);
  expect(run.controllerInput).toBe(input);
  expect(input.source).toBe(run);
  expect(input.mailbox.entries).toEqual([input]);
  expect(lifecycle).not.toHaveProperty("controllerInput");
  retireSessionControllerInput(input);
});

it("captures physical source rather than native command target before preparation", () => {
  const source = prepare(key, "/test/actual.sqlite", "agent:main:other");
  expect(source.input?.mailbox.owner.target).toMatchObject({
    sessionKey: key,
    storeScope: "/test/actual.sqlite",
  });
  const otherStore = prepare(key, "/test/other.sqlite");
  expect(otherStore.input?.mailbox).not.toBe(source.input?.mailbox);
  retireUnadoptedReplySource(source.input);
  retireUnadoptedReplySource(otherStore.input);
});

it("moves the native continuation itself, preserving custody and target backlog", async () => {
  const slash = "agent:main:slash";
  const source = prepare(slash);
  const input = source.input!;
  const { mailbox: previous, instance, custody, settlement } = input;
  const older = reserve();
  retargetReplySourceForExecution({
    ctx: { SessionKey: slash, CommandSource: "native", CommandTargetSessionKey: key },
    options: source.options,
    sessionKey: key,
    storePath: "/test/source.sqlite",
    agentId: "main",
  });
  expect(readReplySourceInput(source.options)).toBe(input);
  expect(input.instance).toBe(instance);
  expect(input.custody).toBe(custody);
  expect(input.settlement).toBe(settlement);
  expect(previous.entries).not.toContain(input);
  expect(input.mailbox).toBe(older.mailbox);
  expect(input.mailbox.entries).toEqual([older, input]);
  expect(tryClaimSessionControllerTask(input)).toBeUndefined();
  retireSessionControllerInput(older);
  await older.settlement.promise;
  const claim = tryClaimSessionControllerTask(input)!;
  expect(claim.inputs).toEqual([input]);
  releaseSessionControllerClaim(claim);
});

it("does not invent a mailbox for a sessionless source", () => {
  const prepared = prepareReplySourceInput({}, {}, undefined);
  expect(prepared.input).toBeUndefined();
});

it("keeps newest interrupt priority after older policy refinement and through delivery", async () => {
  const older = reserve();
  updateSessionControllerSourcePolicy(older, { mode: "interrupt", cap: 2 });
  const newest = reserve();
  updateSessionControllerSourcePolicy(newest, { mode: "interrupt", cap: 3 });
  updateSessionControllerSourcePolicy(older, { mode: "interrupt", cap: 4 });
  expect(older.policy).toEqual({ mode: "interrupt", cap: 4 });
  expect(older.mailbox.priority).toBe(newest);
  expect(older.mailbox.entries).toEqual([older, newest]);
  updateSessionControllerSourcePolicy(older, { mode: "followup" });
  expect(tryClaimSessionControllerTask(older)).toBeUndefined();
  expect(older.phase).toBe("preparing");
  const claim = tryClaimSessionControllerTask(newest)!;
  expect(claim.inputs).toEqual([newest]);
  const operation = createReplyOperation({
    mailboxClaim: claim,
    target,
    sessionKey: key,
    sessionId: "source-session",
    resetTriggered: false,
  });
  const run = createQueueTestRun({ prompt: "hello" });
  bindReplySourceToFollowup(bindReplySourceInput({}, newest), run);
  expect(newest.mailbox.entries).toEqual([older, newest]);
  const raw = createDeferred();
  operation.completeWithAfterClearBarrier(raw.promise);
  releaseSessionControllerClaim(claim);
  const selected = vi.fn();
  const next = claimSessionControllerTask(older, selected, "queued_followup");
  await Promise.resolve();
  expect(selected).not.toHaveBeenCalled();
  raw.resolve();
  await operation.ownerSettlement;
  const nextClaim = await next;
  expect(selected).toHaveBeenCalledOnce();
  releaseSessionControllerClaim(nextClaim);
});
