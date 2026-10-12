/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { resetChatComposerState } from "./components/chat-composer.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

function sessionsResult(rows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  };
}

describe.each([false, true])("chat run activity (recovery ready: %s)", (recoveryScopeReady) => {
  beforeEach(installTranscriptDomMocks);
  afterEach(() => {
    resetChatComposerState();
    resetTranscriptTestDom();
  });

  it.each([
    {
      name: "shows a completed parent waiting on its visible child, not working",
      selectedKey: "agent:main:main",
      parentActive: false,
      expectWorking: false,
      expectWaiting: true,
    },
    {
      name: "shows activity on the visible child itself",
      selectedKey: "agent:main:subagent:attachment-fix",
      parentActive: false,
      expectWorking: true,
      expectWaiting: false,
    },
    {
      name: "shows activity while the parent has its own live turn",
      selectedKey: "agent:main:main",
      parentActive: true,
      expectWorking: true,
      expectWaiting: false,
    },
  ])("$name", ({ selectedKey, parentActive, expectWorking, expectWaiting }) => {
    const parentKey = "agent:main:main";
    const childKey = "agent:main:subagent:attachment-fix";
    const parent = {
      key: parentKey,
      kind: "direct",
      updatedAt: 2,
      status: parentActive ? "running" : "done",
      hasActiveRun: parentActive,
      activeRunIds: parentActive ? ["parent-run"] : [],
      hasActiveSubagentRun: true,
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
    renderChatPropsInto(container, expectDefined(pane.chatProps, "chat props"));

    expect(pane.chatProps?.canAbort).toBe(true);
    expect(
      container.querySelector(
        ".chat-working-indicator:not(.chat-working-indicator--subagents) .chat-reading-indicator",
      ) !== null,
    ).toBe(expectWorking);
    // Live transcript rows render once history has loaded; until then the skeleton owns the pane.
    expect(container.querySelector(".chat-working-indicator--subagents") !== null).toBe(
      expectWaiting && pane.chatProps?.loading !== true,
    );
  });
});
