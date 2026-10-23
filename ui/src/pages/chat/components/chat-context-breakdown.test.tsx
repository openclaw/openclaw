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
import {
  buildChatContextCategories,
  buildDeferredContextGroups,
} from "./chat-context-breakdown-model.ts";
import { ChatContextBreakdown } from "./chat-context-breakdown.tsx";

const workspaceFile = (path: string, chars = 16000) => ({
  name: "AGENTS.md",
  path,
  missing: false,
  rawChars: chars,
  injectedChars: chars,
  truncated: false,
});
const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  systemPrompt: { chars: 40000, projectContextChars: 16000, nonProjectContextChars: 24000 },
  injectedWorkspaceFiles: [workspaceFile("/private/workspace/AGENTS.md")],
  skills: { promptChars: 8000, entries: [{ name: "review", blockChars: 8000 }] },
  tools: {
    listChars: 0,
    schemaChars: 12000,
    entries: [{ name: "exec", summaryChars: 400, schemaChars: 12000 }],
  },
};
const usage = (key: string, sessionId = key) => ({
  sessions: [{ key: `agent:main:${key}`, sessionId, contextWeight: report }],
});
function expectTokens(value: SessionSystemPromptReport, expected: Array<number | null>) {
  const categories = buildChatContextCategories(value, 50000);
  expect(categories.map(({ id, tokens }) => [id, tokens])).toEqual(
    ["messages", "files", "tools", "skills", "system"].map((id, i) => [id, expected[i]]),
  );
  expect(categories[1]?.groups?.[0]?.kind).toBe("other");
}

it("subtracts embedded prompt sections once, and leaves unmeasured and inconsistent sizes unknown", () => {
  expectTokens(report, [37000, 4000, 3000, 2000, 4000]);
  expect(buildChatContextCategories(report, 1000)[0]?.tokens).toBeNull();
  const native = structuredClone(report);
  Object.assign(native.injectedWorkspaceFiles[0]!, {
    path: "/private/AGENTS.md",
    injectionStatus: "native_unverified",
    injectedChars: null,
    truncated: null,
  });
  expectTokens(native, [null, null, 3000, 2000, null]);
});

it("retires a pending report on session replacement and rejects a report from another incarnation", async () => {
  const first = createDeferredCore<ReturnType<typeof usage>>();
  let signal: AbortSignal | undefined;
  let requestIndex = 0;
  const request = createGatewayRequestMock((method, params, options) => {
    const firstRequest = requestIndex++ === 0;
    expect(method).toBe("sessions.usage");
    expect(params).toMatchObject({ key: `agent:main:${firstRequest ? "first" : "second"}` });
    if (firstRequest) {
      signal = options?.signal;
      return first.promise;
    }
    return usage("second", "retired");
  });
  const { gateway, publish } = createApplicationGateway();
  const client = createTestGatewayClient(request);
  publish({ ...gateway.snapshot, phase: "connected", client });
  const [session, setSession] = createSignal<GatewaySessionRow>({
    key: "agent:main:first",
    kind: "direct",
    sessionId: "first",
  });
  const view = mountSolid(() => (
    <ChatContextBreakdown gateway={gateway} session={session()} used={50000} limit={100000} />
  ));
  await expect.poll(() => request.mock.calls.length).toBe(1);
  setSession({ key: "agent:main:second", kind: "direct", sessionId: "current" });
  flush();
  await expect.poll(() => view.container.textContent).toContain("No matching context report");
  expect(signal?.aborted).toBe(true);
  first.resolve(usage("first"));
  await first.promise;
  flush();
  expect(view.container.textContent).not.toContain("AGENTS.md");
  expect(view.container.querySelector(".chat-context__bar")).toBeNull();
  view.unmount();
});

it("keeps refresh available after a rejected read and shows loading until its retry settles", async () => {
  const first = createDeferredCore<ReturnType<typeof usage>>();
  const retry = createDeferredCore<ReturnType<typeof usage>>();
  const request = createGatewayRequestMock(() =>
    request.mock.calls.length === 1 ? first.promise : retry.promise,
  );
  const { gateway, publish } = createApplicationGateway();
  publish({ ...gateway.snapshot, phase: "connected", client: createTestGatewayClient(request) });
  const view = mountSolid(() => (
    <ChatContextBreakdown
      gateway={gateway}
      session={{ key: "agent:main:current", kind: "direct", sessionId: "current" }}
      used={50000}
      limit={100000}
    />
  ));
  const refresh = view.getByRole("button", { name: "Refresh" });
  await expect.poll(() => request.mock.calls.length).toBe(1);
  first.reject(new Error("Context read failed"));
  await expect
    .poll(() => view.getByRole("status").textContent)
    .toBe("Couldn't load the context breakdown. Try refreshing.");
  expect(view.getByRole("button", { name: "Refresh" })).toBe(refresh);
  refresh.click();
  await expect.poll(() => request.mock.calls.length).toBe(2);
  expect(view.getByRole("status").textContent).toBe("Loading context breakdown…");
  expect(view.getByRole("button", { name: "Refresh" })).toBe(refresh);
  retry.resolve(usage("current"));
  await expect.poll(() => view.container.querySelector(".chat-context__bar")).not.toBeNull();
  expect(view.queryByRole("status")).toBeNull();
  expect(view.container.textContent).toContain("AGENTS.md");
  expect(view.getByRole("button", { name: "Refresh" })).toBe(refresh);
  view.unmount();
});

it("groups duplicate filenames by producer origin and keeps deferred schemas outside usage", () => {
  const grouped = structuredClone(report);
  grouped.injectedWorkspaceFiles[0]!.origin = {
    kind: "agent-workspace",
    rootPath: "/private/workspace",
  };
  grouped.injectedWorkspaceFiles.push({
    ...workspaceFile("/project/AGENTS.md", 4000),
    origin: { kind: "execution-project", rootPath: "/project" },
  });
  grouped.tools.entries = [
    { name: "exec", summaryChars: 400, schemaChars: 8000, source: "openclaw" },
    { name: "read", summaryChars: 400, schemaChars: 4000, source: "mcp", serverName: "Docs" },
  ];
  grouped.tools.deferred = {
    schemaChars: 40000,
    entries: [
      { name: "search", source: "mcp", serverName: "Docs", schemaChars: 40000 },
      { name: "remote", source: "client", schemaChars: null },
    ],
  };
  const categories = buildChatContextCategories(grouped, 50000);
  const groups = (id: string) => categories.find((category) => category.id === id)?.groups;
  expect(
    groups("files")?.map((group) => [group.kind, group.tokens, group.entries[0]?.key]),
  ).toEqual([
    ["agent-workspace", 4000, "/private/workspace/AGENTS.md"],
    ["execution-project", 1000, "/project/AGENTS.md"],
  ]);
  expect(groups("tools")?.map((group) => [group.kind, group.name, group.tokens])).toEqual([
    ["openclaw", undefined, 2000],
    ["mcp", "Docs", 1000],
  ]);
  expect(categories.reduce((sum, category) => sum + (category.tokens ?? 0), 0)).toBe(50000);
  expect(buildDeferredContextGroups(grouped).map((group) => [group.kind, group.tokens])).toEqual([
    ["mcp", 10000],
    ["client", null],
  ]);
});
