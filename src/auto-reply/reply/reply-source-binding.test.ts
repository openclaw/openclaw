import { afterEach, describe, expect, it } from "vitest";
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
import type { FollowupRun } from "./queue/types.js";
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
function followup(): FollowupRun {
  return {
    prompt: "hello",
    enqueuedAt: 1,
    run: {
      sessionId: "source-session",
      sessionKey: key,
      agentId: "main",
      agentDir: "/test/agent",
      config: {},
      sessionFile: key,
      workspaceDir: "/test",
      provider: "openai",
      model: "test",
      timeoutMs: 1000,
      blockReplyBreak: "text_end",
    },
  };
}

describe("host-private reply source binding", () => {
  it("carries the Gateway source through lifecycle/options spreads to the actual followup", () => {
    const input = reserve();
    const lifecycle: TurnAdoptionLifecycle = bindReplySourceInput({ onAdopted() {} }, input);
    const options = prepareInternalGetReplyOptions({
      turnAdoptionLifecycle: { ...lifecycle, onAdopted: async () => lifecycle.onAdopted() },
    });
    const prepared = prepareReplySourceInput({ SessionKey: key }, {}, { ...options });
    const run = followup();
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
    const source = prepareReplySourceInput(
      { SessionKey: key, CommandTargetSessionKey: "agent:main:other" },
      { session: { store: "/test/actual.sqlite" } },
      undefined,
    );
    expect(source.input?.mailbox.owner.target).toMatchObject({
      sessionKey: key,
      storeScope: "/test/actual.sqlite",
    });
    const otherStore = prepareReplySourceInput(
      { SessionKey: key },
      { session: { store: "/test/other.sqlite" } },
      undefined,
    );
    expect(otherStore.input?.mailbox).not.toBe(source.input?.mailbox);
    retireUnadoptedReplySource(source.input);
    retireUnadoptedReplySource(otherStore.input);
  });

  it("moves the native continuation itself, preserving custody and target backlog", async () => {
    const source = prepareReplySourceInput(
      { SessionKey: "agent:main:slash" },
      { session: { store: "/test/source.sqlite" } },
      undefined,
    );
    const input = source.input!;
    const previous = input.mailbox;
    const identity = input.instance;
    const custody = input.custody;
    const settlement = input.settlement;
    const older = reserve();
    retargetReplySourceForExecution({
      ctx: {
        SessionKey: "agent:main:slash",
        CommandSource: "native",
        CommandTargetSessionKey: key,
      },
      options: source.options,
      sessionKey: key,
      storePath: "/test/source.sqlite",
      agentId: "main",
    });
    expect(readReplySourceInput(source.options)).toBe(input);
    expect(input.instance).toBe(identity);
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

  it("refines policy on the same input without stealing newer interrupt priority", () => {
    const first = reserve();
    updateSessionControllerSourcePolicy(first, { mode: "interrupt", cap: 2 });
    const latest = reserve();
    updateSessionControllerSourcePolicy(latest, { mode: "interrupt", cap: 3 });
    updateSessionControllerSourcePolicy(first, { mode: "interrupt", cap: 4 });
    expect(first.policy).toEqual({ mode: "interrupt", cap: 4 });
    expect(first.mailbox.priority).toBe(latest);
    expect(first.mailbox.entries).toEqual([first, latest]);
    retireSessionControllerInput(first);
    retireSessionControllerInput(latest);
  });

  it("does not invent a mailbox for a sessionless source", () => {
    const prepared = prepareReplySourceInput({}, {}, undefined);
    expect(prepared.input).toBeUndefined();
  });

  it("selects the newest interrupt before older preparation without duplicating input", async () => {
    const older = reserve();
    const newest = reserve();
    updateSessionControllerSourcePolicy(newest, { mode: "interrupt" });
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
    const run = followup();
    bindReplySourceToFollowup(bindReplySourceInput({}, newest), run);
    expect(newest.mailbox.entries).toEqual([older, newest]);
    let releaseRaw!: () => void;
    const raw = new Promise<void>((resolve) => {
      releaseRaw = resolve;
    });
    operation.completeWithAfterClearBarrier(raw);
    releaseSessionControllerClaim(claim);
    let selected = false;
    const next = claimSessionControllerTask(
      older,
      () => {
        selected = true;
      },
      "queued_followup",
    );
    await Promise.resolve();
    expect(selected).toBe(false);
    releaseRaw();
    await operation.ownerSettlement;
    const nextClaim = await next;
    expect(selected).toBe(true);
    releaseSessionControllerClaim(nextClaim);
  });
});
