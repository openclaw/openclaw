// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";
import { createDeferredCore } from "../../../../../src/shared/deferred.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { buildChatContextCategories } from "./chat-context-breakdown-model.ts";
import { ChatContextBreakdown } from "./chat-context-breakdown.tsx";

const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  systemPrompt: { chars: 40000, projectContextChars: 16000, nonProjectContextChars: 24000 },
  injectedWorkspaceFiles: [
    {
      name: "AGENTS.md",
      path: "/private/workspace/AGENTS.md",
      missing: false,
      rawChars: 16000,
      injectedChars: 16000,
      truncated: false,
    },
  ],
  skills: { promptChars: 8000, entries: [{ name: "review", blockChars: 8000 }] },
  tools: {
    listChars: 0,
    schemaChars: 12000,
    entries: [{ name: "exec", summaryChars: 400, schemaChars: 12000 }],
  },
};

it("subtracts embedded prompt sections once, and leaves unmeasured and inconsistent sizes unknown", () => {
  expect(buildChatContextCategories(report, 50000).map(({ id, tokens }) => [id, tokens])).toEqual([
    ["messages", 37000],
    ["files", 4000],
    ["tools", 3000],
    ["skills", 2000],
    ["system", 4000],
  ]);
  expect(buildChatContextCategories(report, 1000)[0]?.tokens).toBeNull();
  const native: SessionSystemPromptReport = {
    ...report,
    injectedWorkspaceFiles: [
      {
        name: "AGENTS.md",
        path: "/private/AGENTS.md",
        missing: false,
        rawChars: 16000,
        injectionStatus: "native_unverified",
        injectedChars: null,
        truncated: null,
      },
    ],
  };
  expect(buildChatContextCategories(native, 50000).map(({ id, tokens }) => [id, tokens])).toEqual([
    ["messages", null],
    ["files", null],
    ["tools", 3000],
    ["skills", 2000],
    ["system", null],
  ]);
});

it("retires a pending report on session replacement and rejects a report from another incarnation", async () => {
  const first = createDeferredCore<{
    sessions: Array<{ key: string; sessionId: string; contextWeight: SessionSystemPromptReport }>;
  }>();
  let signal: AbortSignal | undefined;
  let requestIndex = 0;
  const request = createGatewayRequestMock((method, params, options) => {
    const firstRequest = requestIndex++ === 0;
    expect(method).toBe("sessions.usage");
    expect(params).toMatchObject({
      key: firstRequest ? "agent:main:first" : "agent:main:second",
    });
    if (firstRequest) {
      signal = options?.signal;
      return first.promise;
    }
    return {
      sessions: [{ key: "agent:main:second", sessionId: "retired", contextWeight: report }],
    };
  });
  const application = createApplicationGateway();
  application.publish({
    ...application.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
  });
  const [session, setSession] = createSignal<GatewaySessionRow>({
    key: "agent:main:first",
    kind: "direct",
    sessionId: "first",
  });
  const view = mountSolid(() => (
    <ChatContextBreakdown
      gateway={application.gateway}
      session={session()}
      used={50000}
      limit={100000}
    />
  ));
  await expect.poll(() => request.mock.calls.length).toBe(1);
  setSession({ key: "agent:main:second", kind: "direct", sessionId: "current" });
  flush();
  await expect.poll(() => view.container.textContent).toContain("No matching context report");
  expect(signal?.aborted).toBe(true);
  first.resolve({
    sessions: [{ key: "agent:main:first", sessionId: "first", contextWeight: report }],
  });
  await first.promise;
  flush();
  expect(view.container.textContent).not.toContain("AGENTS.md");
  expect(view.container.querySelector(".chat-context__bar")).toBeNull();
  view.unmount();
});
