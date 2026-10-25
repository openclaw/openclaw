/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { renderComposerFixture } from "./chat-composer.test-support.ts";
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

const status = ".agent-chat__composer-run-status";

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
  it("announces approval waits without duplicate working chrome", () => {
    const { container } = renderComposerFixture({ runActive: true, waitingApproval: true });
    expect(container.querySelector(".agent-chat__run-status-announcement")?.textContent).toBe(
      "Waiting for approval…",
    );
    expect(container.querySelector(status)).toBeNull();
  });
});
