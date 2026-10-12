/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-session-presentation.test/"} */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { SessionState } from "../../lib/sessions/session-capability.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  nativeHistoryMessage,
} from "./chat-pane.test-support.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const sessions = createSessionCapabilityFixture();
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
    pane.pane.applySessionsState(next);
    for (const callback of frames.splice(0)) {
      callback(0);
    }
  };
  publish(publication);
  requestFrame.mockClear();
  pane.requestUpdate.mockClear();
  return { ...pane, publication, selected, parent, foreign, requestFrame, publish };
}

describe("chat pane session presentation", () => {
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
    expect(f.requestUpdate).toHaveBeenCalledOnce();
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
      f.requestUpdate.mockClear();
      f.requestFrame.mockClear();
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
          expect(f.requestFrame).not.toHaveBeenCalled();
          expect(f.requestUpdate).not.toHaveBeenCalled();
        } else {
          expect(f.requestUpdate).toHaveBeenCalledOnce();
          f.requestUpdate.mockClear();
        }
      }
    },
  );
});
