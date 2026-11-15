import { afterEach, expect, it, vi } from "vitest";
import { withPluginRuntimeGatewayContextResolver as withGateway } from "../../plugins/runtime/gateway-request-scope.js";
import {
  captureSessionTarget,
  getCurrentSessionControllerClaim,
} from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceForGateway,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { registerChatAbortController } from "../chat-abort.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { createTalkClientAgentRuntime } from "./client-agent-runtime.js";

const model = vi.hoisted(() => ({ run: vi.fn() }));
// mock-isolation: Replace model execution while keeping registration, runtime admission and selector real.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: model.run }));
afterEach(() => {
  testing.resetSessionControllerForTest();
  model.run.mockReset();
});

it.each([true, false])(
  "registered Talk runtime never reserves a second input (matching captured Gateway: %s)",
  async (sameScope) => {
    const ambientGateway: GatewayContextResolver = () => undefined;
    const otherGateway: GatewayContextResolver = () => undefined;
    const capturedGateway = sameScope ? ambientGateway : otherGateway;
    const agentId = "main";
    const sessionKey = "agent:main:scope-proof";
    const sessionId = "synthetic-scope-proof";
    const storePath = "/synthetic/talk-scope/sessions.sqlite";
    const runId = "synthetic-talk-run";
    const target = captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      agentId,
      incarnation: sessionId,
    });
    const abort = new AbortController();
    let claimedInput: unknown;
    model.run.mockImplementation(async () => {
      claimedInput = getCurrentSessionControllerClaim()?.inputs[0];
      return { payloads: [{ text: "Checked" }], meta: { durationMs: 0 } };
    });
    await withGateway(ambientGateway, async () => {
      const registration = registerChatAbortController({
        target,
        runId,
        sessionId,
        sessionKey,
        agentId,
        ownerConnId: "synthetic-connection",
        timeoutMs: 60_000,
        kind: "chat-send",
      });
      if (!registration.registered) {
        throw new Error("Expected a fresh Talk registration");
      }
      expect(getRpcSourceForGateway(runId, ambientGateway)).toBe(registration.entry);
      expect(getRpcSourceForGateway(runId, capturedGateway)).toBe(
        sameScope ? registration.entry : undefined,
      );
      const runtime = createTalkClientAgentRuntime({
        config: { plugins: { enabled: false } },
        resolveGatewayContext: capturedGateway,
        rawSourceRef: "synthetic-connection",
        getRegisteredSource: () => registration.entry,
      });
      let outcome: "pending" | "success" | "error" = "pending";
      let failure: unknown;
      const running = runtime
        .runEmbeddedAgent({
          runId,
          sessionId,
          sessionKey,
          agentId,
          sessionTarget: { agentId, sessionId, sessionKey, storePath },
          workspaceDir: "/synthetic/talk-scope/workspace",
          prompt: "Check the request",
          timeoutMs: 5_000,
          abortSignal: abort.signal,
        })
        .then(
          () => {
            outcome = "success";
          },
          (error: unknown) => {
            failure = error;
            outcome = "error";
          },
        );
      try {
        await vi.waitFor(
          () =>
            expect(
              outcome !== "pending" || registration.entry.input.mailbox.entries.length > 1,
            ).toBe(true),
          { timeout: 5_000 },
        );
        expect(
          registration.entry.input.mailbox.entries.length,
          "registered Talk must not silently reserve a fallback input",
        ).toBeLessThanOrEqual(1);
        expect(outcome).not.toBe("pending");
        if (sameScope) {
          expect(failure).toBeUndefined();
          expect(outcome).toBe("success");
          expect(model.run).toHaveBeenCalledOnce();
          expect(claimedInput).toBe(registration.entry.input);
        } else {
          expect(outcome).toBe("error");
          expect(failure).toBeInstanceOf(Error);
          expect(model.run).not.toHaveBeenCalled();
        }
      } finally {
        abort.abort(new Error("synthetic test cleanup"));
        registration.controller.abort();
        await running;
        registration.cleanup();
      }
    });
  },
);

function consultation(runId = "synthetic-bound-run", sessionKey = "agent:main:binding-proof") {
  const agentId = "main";
  const sessionId = "synthetic-bound-session";
  const storePath = "/synthetic/talk-binding/sessions.sqlite";
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    agentId,
    incarnation: sessionId,
  });
  const register = () =>
    registerChatAbortController({
      target,
      runId,
      sessionId,
      sessionKey,
      agentId,
      ownerConnId: "synthetic-connection",
      timeoutMs: 60_000,
      kind: "chat-send",
    });
  const registration = register();
  if (!registration.registered) {
    throw new Error("Expected fresh source");
  }
  let source: RpcSourceRef | undefined = registration.entry;
  const assertCurrent = vi.fn();
  const runtime = createTalkClientAgentRuntime({
    config: { plugins: { enabled: false } },
    rawSourceRef: "synthetic-connection",
    getRegisteredSource: () => source,
    assertCurrent,
  });
  const request = {
    runId,
    sessionId,
    sessionKey,
    agentId,
    sessionTarget: { agentId, sessionId, sessionKey, storePath },
    workspaceDir: "/synthetic/talk-binding/workspace",
    prompt: "Check this consultation",
    timeoutMs: 5_000,
  };
  return {
    runtime,
    request,
    registration,
    register,
    assertCurrent,
    unbind: () => {
      source = undefined;
    },
    close: () => {
      source = undefined;
      registration.controller.abort();
      registration.cleanup();
    },
  };
}

it.each([
  "missing",
  "stale",
  "replaced",
  "cancelled",
  "store",
  "agent",
  "key",
  "incarnation",
  "run",
  "caller",
  "authority",
] as const)("rejects %s source before fallback reservation or model execution", async (reason) => {
  const fixture = consultation();
  let replacement: ReturnType<typeof fixture.register> | undefined;
  let runtime = fixture.runtime;
  let request = fixture.request;
  try {
    if (reason === "missing") {
      fixture.unbind();
    }
    if (reason === "stale" || reason === "replaced") {
      fixture.registration.cleanup();
    }
    if (reason === "replaced") {
      replacement = fixture.register();
      expect(replacement.registered).toBe(true);
      if (replacement.registered) {
        expect(replacement.entry).not.toBe(fixture.registration.entry);
      }
    }
    if (reason === "cancelled") {
      fixture.registration.controller.abort();
    }
    if (reason === "store") {
      request = {
        ...request,
        sessionTarget: { ...request.sessionTarget, storePath: "/synthetic/other/sessions.sqlite" },
      };
    }
    if (reason === "agent") {
      request = { ...request, sessionTarget: { ...request.sessionTarget, agentId: "other" } };
    }
    if (reason === "key") {
      request = {
        ...request,
        sessionTarget: { ...request.sessionTarget, sessionKey: "agent:main:other" },
      };
    }
    if (reason === "incarnation") {
      request = {
        ...request,
        sessionTarget: { ...request.sessionTarget, sessionId: "other-incarnation" },
      };
    }
    if (reason === "run") {
      request = { ...request, runId: "other-run" };
    }
    if (reason === "caller") {
      runtime = createTalkClientAgentRuntime({
        config: {},
        rawSourceRef: "other-connection",
        getRegisteredSource: () => fixture.registration.entry,
      });
    }
    if (reason === "authority") {
      fixture.assertCurrent.mockImplementation(() => {
        throw new Error("synthetic caller revoked");
      });
    }
    const inputs = [...fixture.registration.entry.input.mailbox.entries];
    await expect(runtime.runEmbeddedAgent(request)).rejects.toThrow();
    expect(model.run).not.toHaveBeenCalled();
    expect(fixture.registration.entry.input.mailbox.entries).toEqual(inputs);
    if (replacement?.registered) {
      expect(replacement.entry.input.abortSignal.aborted).toBe(false);
      expect(getRpcSourceForGateway(request.runId, undefined)).toBe(replacement.entry);
    }
  } finally {
    replacement?.controller.abort();
    replacement?.cleanup();
    fixture.close();
  }
});

it("keeps concurrent consultations distinct and preserves FIFO behind an unclaimed predecessor", async () => {
  const first = consultation("synthetic-first");
  const second = consultation("synthetic-second");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const claims: Array<{ runId: string; input: unknown }> = [];
  model.run.mockImplementation(async (params) => {
    claims.push({ runId: params.runId, input: getCurrentSessionControllerClaim()?.inputs[0] });
    if (params.runId === first.request.runId) {
      entered.resolve();
      await release.promise;
    }
    return { payloads: [], meta: { durationMs: 0 } };
  });
  const follower = second.runtime.runEmbeddedAgent(second.request);
  const leader = first.runtime.runEmbeddedAgent(first.request);
  try {
    await entered.promise;
    expect(claims).toEqual([{ runId: first.request.runId, input: first.registration.entry.input }]);
    expect(first.registration.entry.input.mailbox.entries).toHaveLength(2);
    await expect(first.runtime.runEmbeddedAgent(first.request)).rejects.toThrow(
      "already been acquired",
    );
    expect(model.run).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([leader, follower]);
    expect(claims).toEqual([
      { runId: first.request.runId, input: first.registration.entry.input },
      { runId: second.request.runId, input: second.registration.entry.input },
    ]);
  } finally {
    release.resolve();
    first.close();
    second.close();
    await Promise.allSettled([leader, follower]);
  }
});

it("does not let a settled runtime acquire a successor registration with the same run ID", async () => {
  const fixture = consultation();
  let replacement: ReturnType<typeof fixture.register> | undefined;
  model.run.mockResolvedValue({ payloads: [], meta: { durationMs: 0 } });
  try {
    await fixture.runtime.runEmbeddedAgent(fixture.request);
    // The consultation, not its embedded runtime, owns registration cleanup.
    fixture.registration.cleanup();
    await vi.waitFor(() =>
      expect(getRpcSourceForGateway(fixture.request.runId, undefined)).toBeUndefined(),
    );
    replacement = fixture.register();
    expect(replacement.registered).toBe(true);
    await expect(fixture.runtime.runEmbeddedAgent(fixture.request)).rejects.toThrow(
      "already been acquired",
    );
    expect(model.run).toHaveBeenCalledOnce();
    if (replacement.registered) {
      expect(replacement.entry.input.abortSignal.aborted).toBe(false);
    }
  } finally {
    replacement?.controller.abort();
    replacement?.cleanup();
    fixture.close();
  }
});
