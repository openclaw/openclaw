// Tests the exact throw site a displaced CLI candidate hits after steering interrupts its operation.
import { afterEach, describe, expect, it } from "vitest";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

function createTestReplyOperation(
  overrides: Partial<Parameters<typeof createReplyOperation>[0]> = {},
) {
  return createReplyOperation({
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    resetTriggered: false,
    ...overrides,
  });
}

describe("reply run registry displacement", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
  });

  it("pins the exact throw site a displaced CLI candidate hits after steering (#148707)", () => {
    // Steering interrupt (get-reply-run-queue.ts) aborts the active operation
    // and does not await its backend's actual process exit before re-admitting
    // a follow-up turn on the same session key: abortByUser() clears this
    // operation's registry slot synchronously, but the CLI subprocess behind
    // it (agent-runner-cli-candidate.ts) keeps running. When that subprocess
    // finally completes and the fallback loop's next candidate calls
    // bindToolAuthorityRoute, the operation is already aborted/cleared and a
    // new operation now owns the slot.
    // This throw itself is intentional (one owner per session key; see
    // AGENTS.md) and stays green before and after the fix below. The bug is
    // one layer up: model-fallback-runner.ts currently treats this generic
    // Error as an unrecognized provider/model failure and cascades to the
    // next candidate instead of aborting the turn. See the
    // isNonProviderRuntimeCoordinationError coverage in failover-error.test.ts
    // for the red/green gate on that classification.
    const run = createQueueTestRun({ prompt: "displaced operation" });
    const snapshot = prepareReplyToolAuthority(run);
    const route = { provider: "openai", model: "gpt-primary" };
    const sessionKey = "agent:main:displaced";

    const original = createTestReplyOperation({ sessionKey, sessionId: "session-original" });
    original.bindToolAuthoritySnapshot(snapshot);
    expect(replyRunRegistry.get(sessionKey)).toBe(original);

    // Steering interrupts and clears `original`'s slot without waiting for its
    // backend CLI process to actually exit.
    expect(original.abortByUser()).toBe(true);
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();

    // The follow-up turn is admitted on the now-free key.
    const displacer = createTestReplyOperation({ sessionKey, sessionId: "session-displacer" });
    expect(replyRunRegistry.get(sessionKey)).toBe(displacer);

    // `original`'s CLI subprocess finally completes and its fallback candidate
    // tries to bind the tool authority route it needs to run.
    expect(() => original.bindToolAuthorityRoute(route)).toThrow(
      "Reply operation has no active tool authority snapshot",
    );

    displacer.bindToolAuthoritySnapshot(snapshot);
    expect(displacer.bindToolAuthorityRoute(route)).toBeTruthy();
    displacer.complete();
  });
});
