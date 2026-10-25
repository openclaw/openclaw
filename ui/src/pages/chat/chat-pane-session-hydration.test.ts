/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../lib/session-pull-requests.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createFrameClock } from "../../test-helpers/animation-frame-clock.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { AfterCommitEffect } from "./render-lifecycle.ts";

function createSecondaryHydrationPane(scopes = ["operator.admin"]) {
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
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
    [
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      "session.discussion.info",
      "sessions.patch",
      "system.info",
      "sessions.companion.state",
    ],
    scopes,
  );
  const commitEffects: AfterCommitEffect[] = [];
  const afterCommit = (effect: AfterCommitEffect) => {
    commitEffects.push(effect);
    return () => undefined;
  };
  state.renderLifecycle = { afterCommit };
  const framesClock = createFrameClock();
  const frames = framesClock.frames;

  vi.spyOn(window, "requestAnimationFrame").mockImplementation(framesClock.request);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(framesClock.cancel);
  const paintFrame = async () => {
    const callbacks = [...frames.values()];
    frames.clear();
    expect(callbacks.length, "queued animation frames").toBeGreaterThan(0);
    callbacks.forEach((callback) => callback(0));
  };
  const deferTranscript = () => {
    const transcript = deferred<boolean>();
    pane.deferSessionHydrationUntilTranscript(state.sessionKey, transcript.promise);
    return async (committed = true) => {
      if (committed) {
        const client = state.client;
        if (!client) {
          throw new Error("Hydration fixture requires a connected client");
        }
        state.currentSessionId = "hydration-session";
        setChatHistoryLoad(state, {
          phase: "committed",
          sessions: state.sessions,
          client,
          connectionEpoch: state.connectionEpoch,
          sessionKey: state.sessionKey,
          requestAgentId: undefined,
          sessionInfo: { key: state.sessionKey, sessionId: state.currentSessionId, kind: "direct" },
        });
      }
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
    commitEffects,
    pane,
    patch,
    request,
    listBranches,
    state,
    deferTranscript,
    expectNoSecondaryReads,
    paintFrame,
    commit: () => {
      const complete = vi.fn();
      commitEffects[0]!(complete);
      return complete;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it("skips companion hydration for a session-only connection after transcript paint", async () => {
  const f = createSecondaryHydrationPane(["operator.sessions.write"]);
  await f.deferTranscript()();
  f.commit();
  await f.paintFrame();
  await f.paintFrame();
  expect(f.listBranches).toHaveBeenCalledOnce();
  expect(f.request).not.toHaveBeenCalledWith("sessions.companion.state", expect.anything());
});

it.each([
  [false, true],
  [true, true],
  [true, false],
])("paint-gated hydration: returning=%s committed=%s", async (returning, committed) => {
  const f = createSecondaryHydrationPane();
  if (returning) {
    f.state.sessionsResult = {
      sessions: [{ key: f.state.sessionKey, kind: "direct", updatedAt: 20, unread: true }],
    } as never;
    f.pane.presented = false;
  }
  const commitTranscript = f.deferTranscript();
  if (returning) {
    f.pane.presented = true;
  }
  const expectPending = () => {
    expect(f.patch).not.toHaveBeenCalled();
    if (!returning) {
      f.expectNoSecondaryReads();
    }
  };
  expectPending();
  await commitTranscript(committed);
  expect(f.commitEffects).toHaveLength(1);
  expectPending();
  const complete = f.commit();
  for (const step of [() => Promise.resolve(), f.paintFrame]) {
    await step();
    expectPending();
    expect(complete).not.toHaveBeenCalled();
  }
  await f.paintFrame();
  expect(f.patch).toHaveBeenCalledTimes(Number(returning && committed));
  if (!returning) {
    expect(f.listBranches).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith("sessions.companion.state", {
      sessionKey: f.state.sessionKey,
      agentId: "work",
    });
    expect(f.request).toHaveBeenCalledWith("session.discussion.info", expect.anything());
  }
  expect(complete).toHaveBeenCalledOnce();
});

it("drops a previous session's deferred hydration before it reaches commit", async () => {
  const f = createSecondaryHydrationPane();
  const commitPrevious = f.deferTranscript();
  f.state.sessionKey = "agent:main:current-2";
  const commitCurrent = f.deferTranscript();

  await commitPrevious();
  expect(f.commitEffects).toHaveLength(0);

  await commitCurrent();
  expect(f.commitEffects).toHaveLength(1);
});

it("drops secondary work when the session changes between commit and paint", async () => {
  const f = createSecondaryHydrationPane();
  await f.deferTranscript()();

  const complete = f.commit();
  void f.paintFrame();
  f.state.sessionKey = "agent:work:replacement";
  await f.paintFrame();

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
  f.commit();
  for (const method of ["session.discussion.info", "sessions.companion.state"]) {
    expect(f.request).not.toHaveBeenCalledWith(method, expect.anything());
  }
  void f.paintFrame();
  await f.paintFrame();

  expect(f.request).toHaveBeenCalledWith("session.discussion.info", expect.anything());
  expect(f.request).toHaveBeenCalledWith("sessions.companion.state", expect.anything());
});
