import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  admitFollowupTurn,
  createDefaults,
  createRun,
  getFollowupAdmissionTestState,
} from "./followup-turn-admission.test-support.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import {
  prepareReplyToolAuthority,
  resolveFollowupRunToolAuthorityFingerprint,
} from "./reply-tool-authority.js";

const state = getFollowupAdmissionTestState();

describe("queued followup authority", () => {
  it("initializes the queued turn's own authority after the first reply completes", async () => {
    const { admitReplyTurn } = await vi.importActual<typeof import("./reply-turn-admission.js")>(
      "./reply-turn-admission.js",
    );
    const admissionStarted = createDeferred();
    state.admitReply.mockImplementation((params) => {
      admissionStarted.resolve();
      return admitReplyTurn(params);
    });
    const first = createReplyOperation({
      sessionKey: "main",
      sessionId: "queued-session",
      resetTriggered: false,
    });
    first.bindToolAuthoritySnapshot(prepareReplyToolAuthority(createRun()));
    const route = { provider: "claude-cli", model: "claude" };
    const firstFingerprint = first.bindToolAuthorityRoute(route);
    const queued = createRun({ toolsAllow: ["read"], disableTools: true });
    queued.run.senderId = "second-sender";
    queued.run.senderIsOwner = false;
    queued.run.permissionMode = "guarded";
    const expected = resolveFollowupRunToolAuthorityFingerprint(queued, route);
    state.preflight.mockImplementation(async ({ sessionEntry }) => {
      const operation = replyRunRegistry.get("main")!;
      expect(operation).not.toBe(first);
      expect(operation.bindToolAuthorityRoute(route)).toBe(expected);
      expect(operation.toolAuthorityFingerprint).not.toBe(firstFingerprint);
      return sessionEntry;
    });

    const pending = admitFollowupTurn({ queued, defaults: createDefaults() });
    await admissionStarted.promise;
    first.complete();
    const result = await pending;

    expect(result.kind).toBe("admitted");
    expect(state.preflight).toHaveBeenCalledOnce();
    if (result.kind !== "admitted") {
      throw new Error("Queued turn was not admitted");
    }
    expect(result.turn.preflightError).toBeUndefined();
    expect(result.turn.preflightFailurePayload).toBeUndefined();
    expect(result.turn.operation.bindToolAuthorityRoute(route)).toBe(expected);
    result.turn.operation.complete();
    expect(() => result.turn.operation.bindToolAuthorityRoute(route)).toThrow(
      "Reply operation has no active tool authority snapshot",
    );
  });

  it("freezes settled queued policy before preflight and later callback mutations", async () => {
    const queued = createRun({ toolsAllow: ["read"] });
    const operation = createReplyOperation({
      sessionKey: "main",
      sessionId: queued.run.sessionId,
      resetTriggered: false,
    });
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    const config = { tools: { deny: ["exec"] } };
    state.resolveConfig.mockResolvedValue(config);
    const route = { provider: "claude-cli", model: "claude" };
    const expected = resolveFollowupRunToolAuthorityFingerprint(
      { ...queued, run: { ...queued.run, config } },
      route,
    );
    state.preflight.mockImplementation(async ({ sessionEntry }) => {
      expect(operation.bindToolAuthorityRoute(route)).toBe(expected);
      queued.toolsAllow!.push("exec");
      config.tools.deny.length = 0;
      return sessionEntry;
    });

    const result = await admitFollowupTurn({ queued, defaults: createDefaults() });

    expect(result.kind).toBe("admitted");
    expect(operation.bindToolAuthorityRoute(route)).toBe(expected);
    expect(() => operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(queued))).toThrow(
      "Reply operation cannot change tool authority after admission",
    );
  });
});
