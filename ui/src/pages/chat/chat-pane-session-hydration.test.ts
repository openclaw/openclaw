/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { AfterCommitEffect } from "./render-lifecycle.ts";

function createSecondaryHydrationPane() {
  const secondaryResponse = new Promise<never>(() => {});
  const request = vi.fn((_method: string, _params?: unknown) => secondaryResponse);
  const listBranches = vi.fn(() => secondaryResponse);
  const patch = vi.fn().mockResolvedValue({});
  const sessions = {
    capturePullRequestEpoch: vi.fn(() => ({})),
    listBranches,
    patch,
    setPullRequestSummary: vi.fn(),
  } as unknown as SessionCapability;
  const { pane, state } = createTestChatPane({
    client: { request } as unknown as GatewayBrowserClient,
    sessions,
  });
  state.assistantAgentId = "main";
  state.sessionKey = "agent:work:current";
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods([
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    "session.discussion.info",
    "sessions.patch",
    "system.info",
  ]);
  const commitEffects: AfterCommitEffect[] = [];
  const afterCommit = vi.fn((effect: AfterCommitEffect) => {
    commitEffects.push(effect);
    return () => undefined;
  });
  state.renderLifecycle = { afterCommit };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const runAnimationFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    if (callbacks.length === 0) {
      throw new Error("expected a queued animation frame");
    }
    for (const callback of callbacks) {
      callback(0);
    }
  };
  const deferTranscript = () => {
    const transcript = deferred<boolean>();
    pane.deferSessionHydrationUntilTranscript(state.sessionKey, transcript.promise);
    return async (committed = true) => {
      transcript.resolve(committed);
      await transcript.promise;
      await Promise.resolve();
    };
  };
  const expectNoSecondaryReads = () => {
    expect(request).not.toHaveBeenCalled();
    expect(listBranches).not.toHaveBeenCalled();
  };
  return {
    afterCommit,
    commitEffects,
    pane,
    patch,
    request,
    listBranches,
    runAnimationFrame,
    state,
    deferTranscript,
    expectNoSecondaryReads,
  };
}

describe("chat pane session hydration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lets the committed transcript paint before starting secondary RPCs together", async () => {
    const f = createSecondaryHydrationPane();
    const commitTranscript = f.deferTranscript();
    f.expectNoSecondaryReads();
    await commitTranscript();

    expect(f.afterCommit).toHaveBeenCalledOnce();
    f.expectNoSecondaryReads();

    const complete = vi.fn();
    f.commitEffects[0]!(complete);
    await Promise.resolve();

    f.expectNoSecondaryReads();
    expect(complete).not.toHaveBeenCalled();

    f.runAnimationFrame();
    await Promise.resolve();
    f.expectNoSecondaryReads();
    expect(complete).not.toHaveBeenCalled();

    f.runAnimationFrame();
    await Promise.resolve();
    expect(f.listBranches).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "system.info",
      "session.discussion.info",
      "sessions.companion.state",
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    ]);
    expect(
      f.request.mock.calls.find(([method]) => method === "sessions.companion.state")?.[1],
    ).toEqual({ sessionKey: f.state.sessionKey, agentId: "work" });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("drops a previous session's deferred hydration before it reaches commit", async () => {
    const f = createSecondaryHydrationPane();
    const commitPrevious = f.deferTranscript();
    f.state.sessionKey = "agent:main:current-2";
    const commitCurrent = f.deferTranscript();

    await commitPrevious();
    expect(f.afterCommit).not.toHaveBeenCalled();

    await commitCurrent();
    expect(f.afterCommit).toHaveBeenCalledOnce();
  });

  it("drops secondary work when the session changes between commit and paint", async () => {
    const f = createSecondaryHydrationPane();
    await f.deferTranscript()();

    const complete = vi.fn();
    f.commitEffects[0]!(complete);
    f.runAnimationFrame();
    f.state.sessionKey = "agent:work:replacement";
    f.runAnimationFrame();
    await Promise.resolve();

    f.expectNoSecondaryReads();
    expect(f.patch).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("resumes deferred companion and discussion hydration when a retained pane returns", async () => {
    const f = createSecondaryHydrationPane();
    const commitTranscript = f.deferTranscript();
    f.pane.presented = false;
    await commitTranscript();

    expect(f.commitEffects).toHaveLength(0);
    expect(f.request).not.toHaveBeenCalled();

    f.pane.presented = true;
    expect(f.commitEffects).toHaveLength(1);
    f.commitEffects[0]!(vi.fn());
    expect(f.request.mock.calls.map(([method]) => method).toSorted()).toEqual([
      "chat.metadata",
      "models.list",
    ]);
    f.runAnimationFrame();
    f.runAnimationFrame();
    await Promise.resolve();

    const methods = f.request.mock.calls.map(([method]) => method);
    expect(methods).toContain("session.discussion.info");
    expect(methods).toContain("sessions.companion.state");
  });

  it.each([
    { name: "commits", committed: true, expectedPatches: 1 },
    { name: "fails", committed: false, expectedPatches: 0 },
  ])(
    "acknowledges unread only after deferred transcript hydration $name",
    async ({ committed, expectedPatches }) => {
      const f = createSecondaryHydrationPane();
      f.state.sessionsResult = {
        sessions: [
          {
            key: f.state.sessionKey,
            kind: "direct",
            updatedAt: 20,
            unread: true,
          },
        ],
      } as never;

      f.pane.presented = false;
      const commitTranscript = f.deferTranscript();
      f.pane.presented = true;
      expect(f.patch).not.toHaveBeenCalled();

      await commitTranscript(committed);
      expect(f.commitEffects).toHaveLength(1);

      f.commitEffects[0]!(vi.fn());
      expect(f.patch).not.toHaveBeenCalled();
      f.runAnimationFrame();
      expect(f.patch).not.toHaveBeenCalled();
      f.runAnimationFrame();
      await Promise.resolve();
      expect(f.patch).toHaveBeenCalledTimes(expectedPatches);
    },
  );
});
