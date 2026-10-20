import { createEffect, flush } from "solid-js";
/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-session-presentation.test/"} */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionState } from "../../lib/sessions/session-capability.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createSessionContext,
  createTestChatPane,
  nativeHistoryMessage,
} from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const listeners = new Set<(state: SessionState) => void>();
  const sessions = createSessionCapabilityFixture({
    state: { agentId: "main" },
    presentation: { result: null, agentId: "main" },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  let current = sessions.state;
  Object.defineProperty(sessions, "state", { get: () => current });
  const pane = createTestChatPane({ client: createGatewayBrowserClientFixture(), sessions });
  pane.state.chatMessages = [nativeHistoryMessage(1)];
  const selected: GatewaySessionRow = {
    key: pane.state.sessionKey,
    kind: "direct",
    updatedAt: 1,
    label: "Selected",
    spawnedBy: "agent:main:parent",
  };
  const parent: GatewaySessionRow = { key: "agent:main:parent", kind: "direct", label: "Parent" };
  const foreign: GatewaySessionRow = { key: "agent:main:foreign", kind: "direct", label: "Other" };
  const frames: FrameRequestCallback[] = [];
  const requestFrame = vi.fn((callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  const publication: SessionState = {
    ...current,
    result: sessionsResult([selected, parent, foreign], 1),
  };
  const publish = (
    next: SessionState,
    presentation: Pick<SessionState, "result" | "agentId"> = next,
  ) => {
    current = next;
    Object.assign(sessions.presentation, presentation);
    pane.pane.applySessionsState(next);
    listeners.forEach((listener) => listener(next));
    for (const callback of frames.splice(0)) {
      callback(0);
    }
    flush();
  };
  publish(publication);
  const rendered = vi.fn();
  const view = mountSolid(() => {
    createEffect(() => [pane.state.sessionsResult], rendered);
    return null;
  });
  flush();
  rendered.mockClear();
  return { ...pane, publication, selected, parent, foreign, rendered, publish, view, listeners };
}

const presentationChanges: Record<
  string,
  (f: ReturnType<typeof fixture>, next: SessionState) => void
> = {
  selected: (f, next) => (next.result!.sessions[0] = { ...f.selected, label: "Renamed" }),
  parent: (f, next) => (next.result!.sessions[1] = { ...f.parent, label: "Renamed parent" }),
  defaults: (_f, next) => (next.result!.defaults.contextTokens = 200_000),
  owners: (_f, next) => (next.result!.owners = [{ type: "human", id: "riley", label: "Riley" }]),
  "model override": (f, next) =>
    (next.modelOverrides = { [f.state.sessionKey]: "openai/gpt-5.6-sol" }),
  "default model override": (f, next) => (next.modelOverrides = { [f.state.sessionKey]: null }),
  "thinking claim": (f) => vi.spyOn(f.state.sessions, "think").mockReturnValue("high"),
  "archive pending": (f) => f.state.sessions.beginArchive(f.state.sessionKey, undefined),
  groups: (_f, next) => (next.groups = ["Project"]),
  "discovered group": (f, next) =>
    (next.result!.sessions[2] = { ...f.foreign, category: "Project" }),
  loading: (_f, next) => (next.loading = true),
  error: (_f, next) => (next.error = "Refresh failed"),
  removed: (f, next) => (next.result!.sessions = [f.parent, f.foreign]),
};

describe("chat pane session presentation", () => {
  it.each([undefined, { agentId: "research" }])(
    "initializes projected page state from an empty or partial session fixture (%s)",
    (stateOverride) => {
      const sessions = createSessionCapabilityFixture({ state: stateOverride });
      const context = createSessionContext(createGatewayBrowserClientFixture(), sessions);
      const state = createPageState(
        context,
        { afterCommit: () => () => {} },
        { dispatchEvent: () => true },
      );
      const rendered = vi.fn();
      const view = mountSolid(() => {
        createEffect(() => state.sessionsResult?.sessions[0]?.label, rendered);
        return null;
      });
      rendered.mockClear();
      state.sessionsResult = sessionsResult(
        [{ key: state.sessionKey, kind: "direct", label: "Projected page title" }],
        1,
      );
      flush();
      expect(rendered).toHaveBeenCalledWith("Projected page title", undefined);
      view.unmount();
    },
  );

  it.each(Object.entries(presentationChanges))(
    "redraws when the visible %s presentation changes",
    (_change, change) => {
      const f = fixture();
      const result = sessionsResult([f.selected, f.parent, f.foreign], 2);
      const next: SessionState = { ...f.publication, result };
      change(f, next);
      f.publish(next);
      expect(f.rendered).toHaveBeenCalledOnce();
    },
  );

  it("redraws accepted roster title changes while the selected descriptor stays unchanged", () => {
    const f = fixture();
    const presentation = {
      agentId: "main",
      result: sessionsResult([{ ...f.selected, label: "Accepted roster title" }], 2),
    };
    f.publish(f.publication, presentation);
    expect(f.rendered).toHaveBeenCalledOnce();
    f.rendered.mockClear();
    f.publish(f.publication, presentation);
    expect(f.rendered).not.toHaveBeenCalled();
  });

  it.each(["transcript", "welcome", "approval"] as const)(
    "redraws foreign roster updates only when visible in the %s",
    (surface) => {
      const f = fixture();
      if (surface === "welcome") {
        f.state.chatMessages = [];
      } else if (surface === "approval") {
        f.state.chatSessionApprovalQueue = [
          {
            id: "approval",
            kind: "exec",
            request: { command: "echo test", sessionKey: f.state.sessionKey },
            sourceSessionKey: f.foreign.key,
            createdAtMs: 1,
            expiresAtMs: 10_000,
          },
        ];
      }
      f.publish(f.publication);
      f.rendered.mockClear();
      for (const updatedAt of [2, 3, 4]) {
        const result = sessionsResult(
          [
            f.selected,
            f.parent,
            {
              ...f.foreign,
              ...(surface === "transcript" ? { updatedAt } : {}),
              label: `Other ${updatedAt}`,
            },
          ],
          updatedAt,
        );
        f.publish({ ...f.publication, result });
        expect(f.state.sessionsResult).toBe(result);
        if (surface === "transcript") {
          expect(f.rendered).not.toHaveBeenCalled();
        } else {
          expect(f.rendered).toHaveBeenCalledOnce();
          f.rendered.mockClear();
        }
      }
    },
  );

  it("publishes direct row replacements and releases the owner subscription", () => {
    const f = fixture();
    const result = sessionsResult([{ ...f.selected, label: "Observed row" }, f.parent], 2);
    f.state.sessionsResult = result;
    expect(f.state.sessionsResult).toBe(result);
    flush();
    expect(f.rendered).toHaveBeenCalledOnce();
    f.view.unmount();
    expect(f.listeners.size).toBe(0);
    f.rendered.mockClear();
    f.state.sessionsResult = sessionsResult([f.selected], 3);
    flush();
    expect(f.rendered).not.toHaveBeenCalled();
  });

  it("publishes selected row mutations from the owner's same-object notification", () => {
    const f = fixture();
    const result = f.publication.result!;
    f.selected.label = "Updated in place";
    f.publish(f.publication);
    expect(f.state.sessionsResult).toBe(result);
    expect(f.rendered).toHaveBeenCalledOnce();
  });
});
