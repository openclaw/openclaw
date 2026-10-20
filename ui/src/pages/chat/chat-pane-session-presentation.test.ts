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
import { projectChatSessionPresentation } from "./chat-session-presentation-projection.ts";
import { createPageState } from "./chat-state-page.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const listeners = new Set<(state: SessionState) => void>();
  let current: SessionState = {
    agentId: "main",
    deletedSessions: [],
    error: null,
    groups: [],
    groupSettings: [],
    loading: false,
    modelOverrides: {},
    sectionOrder: [],
    result: null,
  };
  const sessions = createSessionCapabilityFixture({
    presentation: { result: null, agentId: "main" },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
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
    agentId: "main",
    deletedSessions: [],
    error: null,
    groups: [],
    groupSettings: [],
    loading: false,
    modelOverrides: {},
    sectionOrder: [],
    result: sessionsResult([selected, parent, foreign], 1),
  };
  const publish = (next: SessionState) => {
    current = next;
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
    projectChatSessionPresentation(pane.state, pane.pane.context);
    createEffect(() => [pane.state.sessionsResult], rendered);
    return null;
  });
  flush();
  rendered.mockClear();
  return { ...pane, publication, selected, parent, foreign, rendered, publish, view, listeners };
}

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

  it.each([
    "selected",
    "parent",
    "defaults",
    "owners",
    "model override",
    "default model override",
    "thinking claim",
    "archive pending",
    "groups",
    "discovered group",
    "loading",
    "error",
    "removed",
  ] as const)("redraws when the visible %s presentation changes", (change) => {
    const f = fixture();
    const result = sessionsResult([f.selected, f.parent, f.foreign], 2);
    const next: SessionState = { ...f.publication, result };
    switch (change) {
      case "selected":
        result.sessions[0] = { ...f.selected, label: "Renamed" };
        break;
      case "parent":
        result.sessions[1] = { ...f.parent, label: "Renamed parent" };
        break;
      case "defaults":
        result.defaults = { ...result.defaults, contextTokens: 200_000 };
        break;
      case "owners":
        result.owners = [{ type: "human", id: "riley", label: "Riley" }];
        break;
      case "model override":
        next.modelOverrides = { [f.state.sessionKey]: "openai/gpt-5.6-sol" };
        break;
      case "default model override":
        next.modelOverrides = { [f.state.sessionKey]: null };
        break;
      case "thinking claim":
        vi.spyOn(f.state.sessions, "think").mockReturnValue("high");
        break;
      case "archive pending":
        f.state.sessions.beginArchive(f.state.sessionKey, undefined);
        break;
      case "groups":
        next.groups = ["Project"];
        break;
      case "discovered group":
        result.sessions[2] = { ...f.foreign, category: "Project" };
        break;
      case "loading":
        next.loading = true;
        break;
      case "error":
        next.error = "Refresh failed";
        break;
      case "removed":
        result.sessions = [f.parent, f.foreign];
        break;
    }
    f.publish(next);
    expect(f.rendered).toHaveBeenCalledOnce();
  });

  it("redraws accepted roster title changes while the selected descriptor stays unchanged", () => {
    const f = fixture();
    f.sessions.presentation.result = sessionsResult(
      [{ ...f.selected, label: "Accepted roster title" }],
      2,
    );
    f.publish(f.publication);
    expect(f.rendered).toHaveBeenCalledOnce();
    f.rendered.mockClear();
    f.publish(f.publication);
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
