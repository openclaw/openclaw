/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { resetChatComposerState } from "./components/chat-composer.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatComposerState();
  resetTranscriptTestDom();
  vi.restoreAllMocks();
});

const reading = ".chat-working-indicator .chat-reading-indicator";
const status = ".agent-chat__composer-run-status";
const children = ".chat-working-indicator__subagents";
const timer = ".chat-working-indicator openclaw-elapsed-time";

const parentKey = "agent:main:main";
const childKey = "agent:main:subagent:attachment-fix";
describe.each([false, true])("chat run activity (recovery ready: %s)", (recoveryScopeReady) => {
  it.each([
    // A completed parent's generic recovery status waits for its own child query.
    [parentKey, false, recoveryScopeReady],
    [childKey, false, true],
    [parentKey, true, true],
  ] as const)("%s active=%s working=%s", (selectedKey, parentActive, expectWorking) => {
    const parent = {
      key: parentKey,
      kind: "direct",
      updatedAt: 2,
      status: parentActive ? "running" : "done",
      hasActiveRun: parentActive,
      activeRunIds: parentActive ? ["parent-run"] : [],
      hasActiveSubagentRun: true,
      startedAt: 1_000,
      endedAt: parentActive ? undefined : 2_000,
      childSessions: [childKey],
    } satisfies GatewaySessionRow;
    const child = {
      key: childKey,
      kind: "direct",
      updatedAt: 3,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["child-run"],
      subagentRunState: "active",
      spawnedBy: parentKey,
      parentSessionKey: parentKey,
      startedAt: 1,
    } satisfies GatewaySessionRow;
    const client = {
      request: async () => ({}),
      recoveryScopeReady,
    } as unknown as GatewayBrowserClient;
    const { pane, state, context } = createRefreshChatPane(client);
    context.gateway.snapshot.hello = sessionMutationGatewayHello(["operator.write"]);
    state.sessionKey = selectedKey;
    state.sessionsResult = sessionsResult([parent, child]);
    pane.render();

    const container = createApplicationContextProvider(context);
    renderChatPropsInto(container, expectDefined(pane.chatProps, "chat props"), context);

    expect(pane.chatProps?.canAbort).toBe(true);
    expect(
      container.querySelector(
        ".chat-working-indicator:not(.chat-working-indicator--subagents) .chat-reading-indicator",
      ) !== null,
    ).toBe(expectWorking);
    expect(container.querySelector(`.chat-working-indicator--subagents,${status}`)).toBeNull();
  });
});

describe("composer run status", () => {
  it.each(["editable", "view-only subagent", "read-only shared"] as const)(
    "keeps %s child counts and the request timer through roster hydration and settlement",
    async (access) => {
      vi.spyOn(Date, "now").mockReturnValue(66_500);
      const parent: GatewaySessionRow = {
        key: access === "view-only subagent" ? "agent:main:subagent:parent" : "agent:main:parent",
        kind: "direct",
        ...(access === "read-only shared"
          ? { visibility: "read-only" as const, sharingRole: "viewer" as const }
          : {}),
        hasActiveRun: false,
        hasActiveSubagentRun: true,
        startedAt: 1_000,
        endedAt: 2_500,
      };
      const child: GatewaySessionRow = {
        key: "agent:main:subagent:backend",
        kind: "direct",
        spawnedBy: parent.key,
        label: "Backend implementation",
        hasActiveRun: true,
        startedAt: 5_000,
      };
      const { pane, state, context } = createRefreshChatPane();
      state.sessionKey = parent.key;
      state.sessionsResult = sessionsResult([parent]);
      pane.render();
      const container = createApplicationContextProvider(context);
      const onOpenSubagents = vi.fn();
      const draw = async (rows: GatewaySessionRow[], hydrated = true) => {
        renderChatPropsInto(
          container,
          {
            ...expectDefined(pane.chatProps, "chat props"),
            selectedSession: parent,
            messages: [
              { role: "user", content: "Implement the backend.", timestamp: 1_500 },
              {
                role: "assistant",
                runId: "parent-run",
                timestamp: 2_000,
                content: [
                  { type: "text", text: "The backend work is delegated." },
                  { type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} },
                ],
              },
              {
                role: "toolResult",
                runId: "parent-run",
                toolCallId: "yield",
                toolName: "sessions_yield",
                timestamp: 2_001,
                content: [{ type: "text", text: '{"status":"yielded"}' }],
              },
            ],
            subagentSessions: rows,
            subagentSessionsHydrated: hydrated,
            onOpenSubagents,
          },
          context,
        );
        flush();
        expect(container.querySelector(status)).toBeNull();
      };
      await draw([], false);
      expect(container.querySelector(reading)).not.toBeNull();
      await draw([child]);
      await vi.dynamicImportSettled();
      flush();
      if (access === "view-only subagent") {
        expect(container.querySelector(".agent-chat__disabled-banner")?.textContent).toContain(
          "View-only subagent",
        );
        expect(container.querySelector(".agent-chat__composer-combobox")).toBeNull();
      }
      expect(
        container.querySelector(`${reading},.chat-subagent-activity,openclaw-working-phrase`),
      ).toBeNull();
      expect(container.textContent).not.toContain("Backend implementation");
      const count = container.querySelector<HTMLButtonElement>(children);
      expect(count?.textContent).toBe("1 subagent running");
      count?.click();
      expect(onOpenSubagents).toHaveBeenCalledExactlyOnceWith();
      expect(container.querySelector(timer)?.textContent).toBe("1m 5s");

      await draw([
        child,
        { ...child, key: "agent:main:subagent:frontend", label: "Frontend implementation" },
      ]);
      expect(container.querySelector(children)?.textContent).toBe("2 subagents running");
      expect(container.querySelectorAll(timer)).toHaveLength(1);
      expect(container.querySelector(".chat-subagent-activity")).toBeNull();

      await draw([{ ...child, hasActiveRun: false }]);
      expect(container.querySelector(`.chat-subagent-activity,${children}`)).toBeNull();
    },
  );

  it("keeps the composer free of duplicate working status across run and access states", () => {
    const { context } = createRefreshChatPane();
    const container = createComposerContainer();
    container.setContext(context);
    const props = createComposerProps();
    const draw = () => {
      renderComposerInto(container, props);
      expect(container.querySelector(status)).toBeNull();
    };
    draw();
    props.runActive = true;
    draw();
    props.disabledBanner = {
      kind: "composer-replacement",
      text: "This conversation is view-only.",
    };
    draw();
    expect(container.querySelector(".agent-chat__composer-combobox")).toBeNull();
    props.waitingApproval = true;
    draw();
    props.waitingApproval = false;
    props.runStatus = { phase: "done", runId: "work", sessionKey: props.sessionKey, occurredAt: 1 };
    draw();
  });
});
