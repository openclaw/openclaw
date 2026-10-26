// @vitest-environment jsdom

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";
import { createDeferredCore } from "../../../../../src/shared/deferred.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { sessionContextReportsForGateway } from "../../../lib/session-context-report.ts";
import * as toast from "../../../lib/toast.ts";
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
import { ChatContextPage } from "./chat-context-page.tsx";

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

it("keeps total usage when session replacement rejects a report from another incarnation", async () => {
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
    <ChatContextBreakdown
      gateway={gateway}
      session={session()}
      used={session().totalTokens ?? 72400}
      limit={1000000}
      approximate={session().totalTokensFresh === false}
      popover
    />
  ));
  await expect.poll(() => request.mock.calls.length).toBe(1);
  setSession((current) => ({ ...current, label: "Renamed session" }));
  flush();
  expect(request).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  setSession({ key: "agent:main:second", kind: "direct", sessionId: "current" });
  flush();
  await expect.poll(() => view.container.querySelector('[role="meter"]')).not.toBeNull();
  expect(signal?.aborted).toBe(true);
  first.resolve(usage("first"));
  await first.promise;
  flush();
  expect(view.container.textContent).not.toContain("AGENTS.md");
  const total = view.getByRole("meter", { name: "Context" });
  expect(total.getAttribute("aria-valuenow")).toBe("72400");
  expect(total.getAttribute("aria-valuemax")).toBe("1000000");
  expect(total.getAttribute("aria-valuetext")).toBe("72.4k of 1M tokens");
  expect(view.container.querySelectorAll("[data-context-category]")).toHaveLength(0);
  setSession((current) => ({ ...current, totalTokens: 80000, totalTokensFresh: false }));
  flush();
  expect(total.getAttribute("aria-valuetext")).toBe("~80k of 1M tokens");
  view.unmount();
});

it("offers retry after a rejected read and keeps loading until recovery settles", async () => {
  const first = createDeferredCore<ReturnType<typeof usage>>();
  const retry = createDeferredCore<ReturnType<typeof usage>>();
  const request = createGatewayRequestMock(() =>
    request.mock.calls.length === 1 ? first.promise : retry.promise,
  );
  const { gateway, publish } = createApplicationGateway();
  publish({ ...gateway.snapshot, phase: "connected", client: createTestGatewayClient(request) });
  const view = mountSolid(() => (
    <ChatContextPage
      presented
      details={{
        currentAgentId: "main",
        pullRequestsGateway: gateway,
        selectedSession: {
          key: "agent:main:current",
          kind: "direct",
          sessionId: "current",
          totalTokens: 50000,
          totalTokensFresh: true,
          contextTokens: 100000,
        },
      }}
    />
  ));
  await expect.poll(() => request.mock.calls.length).toBe(1);
  first.reject(new Error("Context read failed"));
  await expect
    .poll(() => view.container.textContent)
    .toContain("Couldn't load the context breakdown");
  view.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => request.mock.calls.length).toBe(2);
  expect(view.container.querySelector(".chat-context-page--loading")).not.toBeNull();
  expect(view.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(true);
  retry.resolve(usage("current"));
  await expect.poll(() => view.container.querySelector(".chat-context-page--loading")).toBeNull();
  expect(view.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false);
  view.container.querySelector<HTMLButtonElement>('[data-context-category="files"]')!.click();
  flush();
  expect(view.container.textContent).toContain("AGENTS.md");
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

it("reports only the current manual refresh failure after reconnect", async () => {
  const stale = createDeferredCore<ReturnType<typeof usage>>();
  const denied = new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Access changed" });
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(usage("first"))
    .mockReturnValueOnce(stale.promise)
    .mockRejectedValue(denied);
  const { gateway, publish } = createApplicationGateway();
  const client = createTestGatewayClient(request);
  publish({ ...gateway.snapshot, phase: "connected", client });
  const notify = vi.spyOn(toast, "showToast").mockReturnValue(true);
  const view = mountSolid(() => (
    <ChatContextPage
      presented
      details={{
        currentAgentId: "main",
        pullRequestsGateway: gateway,
        selectedSession: {
          key: "agent:main:first",
          kind: "direct",
          sessionId: "first",
          totalTokens: 50000,
          totalTokensFresh: true,
          contextTokens: 100000,
        },
        runActive: false,
      }}
    />
  ));
  try {
    await expect.poll(() => view.container.querySelector(".chat-context__bar")).not.toBeNull();
    view.container.querySelector<HTMLButtonElement>(".chat-context__refresh")!.click();
    expect(request).toHaveBeenCalledTimes(2);
    const pendingRefresh = sessionContextReportsForGateway(gateway).refresh({
      sessionKey: "agent:main:first",
      agentId: "main",
      sessionId: "first",
      used: 50000,
    });
    publish({ ...gateway.snapshot, phase: "reconnecting" });
    publish({ ...gateway.snapshot, phase: "connected", client });
    await expect.poll(() => view.container.textContent).toContain("Couldn");
    expect(request).toHaveBeenCalledTimes(3);
    stale.resolve(usage("first"));
    await pendingRefresh;
    flush();
    expect(notify).not.toHaveBeenCalled();
    const retry = view.container.querySelector<HTMLButtonElement>(
      "openclaw-panel-empty-state button",
    )!;
    expect(retry.textContent).toBe("Retry");
    retry.click();
    await expect.poll(() => notify.mock.calls.length).toBe(1);
    expect(request).toHaveBeenCalledTimes(4);
  } finally {
    view.unmount();
    notify.mockRestore();
  }
});

function mountContextPage(
  value: SessionSystemPromptReport = report,
  options: { empty?: boolean; offline?: boolean; missing?: boolean; failure?: boolean } = {},
) {
  const request = createGatewayRequestMock().mockResolvedValue({
    sessions: options.missing
      ? []
      : [{ key: "agent:main:first", sessionId: "first", contextWeight: value }],
  });
  if (options.failure) {
    request.mockRejectedValue(new GatewayProtocolRequestError({ code: "FORBIDDEN" }));
  }
  const { gateway, publish } = createApplicationGateway();
  if (!options.offline) {
    publish({ ...gateway.snapshot, phase: "connected", client: createTestGatewayClient(request) });
  }
  const view = mountSolid(() => (
    <ChatContextPage
      presented
      details={{
        currentAgentId: "main",
        pullRequestsGateway: gateway,
        selectedSession: {
          key: "agent:main:first",
          kind: "direct",
          sessionId: "first",
          ...(options.empty
            ? {}
            : { totalTokens: 50000, totalTokensFresh: true, contextTokens: 100000 }),
        },
        runActive: false,
        onCompact: vi.fn(),
      }}
    />
  ));
  flush();
  const requested = !options.empty && !options.offline;
  expect(request).toHaveBeenCalledTimes(requested ? 1 : 0);
  const ready = requested
    ? sessionContextReportsForGateway(gateway).refresh({
        sessionKey: "agent:main:first",
        agentId: "main",
        sessionId: "first",
        used: 50000,
      })
    : Promise.resolve();
  return { ...view, request, gateway, ready };
}

it("opens one category, returns focus on Escape, and clears linked highlight when focus moves to Refresh", async () => {
  const view = mountContextPage();
  try {
    await view.ready;
    flush();
    expect(view.container.querySelector(".chat-context__bar")).not.toBeNull();
    const files = view.container.querySelector<HTMLButtonElement>(
      '[data-context-category="files"]',
    )!;
    const tools = view.container.querySelector<HTMLButtonElement>(
      '[data-context-category="tools"]',
    )!;
    vi.useFakeTimers();
    files.focus();
    await vi.advanceTimersByTimeAsync(59);
    flush();
    expect(files.classList.contains("chat-context__highlighted")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    flush();
    expect(files.classList.contains("chat-context__highlighted")).toBe(true);
    files.click();
    flush();
    expect(files.getAttribute("aria-expanded")).toBe("true");
    tools.focus();
    tools.click();
    flush();
    expect(tools.classList.contains("chat-context__highlighted")).toBe(true);
    expect(files.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelectorAll("[data-context-section]")).toHaveLength(1);
    tools.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(tools.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(tools);
    view.container.querySelector<HTMLButtonElement>(".chat-context__refresh")!.focus();
    await vi.advanceTimersByTimeAsync(139);
    flush();
    expect(tools.classList.contains("chat-context__highlighted")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    flush();
    expect(tools.classList.contains("chat-context__highlighted")).toBe(false);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it.each([20, 21])(
  "shows an unsearched short list or eight of a long list (%i entries) and preserves search through refresh",
  async (count) => {
    const value = {
      ...report,
      skills: {
        promptChars: 8000,
        entries: Array.from({ length: count }, (_, index) => ({
          name: `skill-${index + 1}`,
          blockChars: 100,
        })),
      },
    };
    const view = mountContextPage(value);
    try {
      await view.ready;
      flush();
      expect(view.container.querySelector(".chat-context__bar")).not.toBeNull();
      const skills = view.container.querySelector<HTMLButtonElement>(
        '[data-context-category="skills"]',
      )!;
      skills.click();
      flush();
      const section = () => view.container.querySelector('[data-context-section="skills"]')!;
      expect(section().querySelectorAll(".chat-context__entry")).toHaveLength(
        count > 20 ? 8 : count,
      );
      expect(section().querySelector("input")).toBeNull();
      if (count === 20) {
        expect(section().querySelector(".chat-context__show-all")).toBeNull();
        return;
      }
      section().querySelector<HTMLButtonElement>(".chat-context__show-all")!.click();
      flush();
      const input = section().querySelector<HTMLInputElement>("input")!;
      expect(document.activeElement).toBe(input);
      expect(section().querySelectorAll(".chat-context__entry")).toHaveLength(count);
      input.value = "skill-21";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(section().querySelectorAll(".chat-context__entry")).toHaveLength(1);
      expect(view.request).toHaveBeenCalledTimes(1);
      const update = createDeferredCore<{
        sessions: Array<{
          key: string;
          sessionId: string;
          contextWeight: SessionSystemPromptReport;
        }>;
      }>();
      view.request.mockReturnValueOnce(update.promise);
      view.container.querySelector<HTMLButtonElement>(".chat-context__refresh")!.click();
      flush();
      expect(view.request).toHaveBeenCalledTimes(2);
      const refreshed = sessionContextReportsForGateway(view.gateway).refresh({
        sessionKey: "agent:main:first",
        agentId: "main",
        sessionId: "first",
        used: 50000,
      });
      expect(skills.getAttribute("aria-expanded")).toBe("true");
      expect(section().querySelector("input")).toBe(input);
      expect(section().textContent).toContain("skill-21");
      expect(view.container.querySelector(".chat-context-page--loading")).toBeNull();
      update.resolve({
        sessions: [
          {
            key: "agent:main:first",
            sessionId: "first",
            contextWeight: {
              ...value,
              generatedAt: 2,
              skills: {
                ...value.skills,
                entries: [...value.skills.entries, { name: "skill-21-new", blockChars: 200 }],
              },
            },
          },
        ],
      });
      await refreshed;
      flush();
      expect(section().querySelectorAll(".chat-context__entry")).toHaveLength(2);
      expect(section().querySelector("input")).toBe(input);
      expect(input.value).toBe("skill-21");
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      flush();
      expect(view.container.querySelector("[data-context-section]")).toBeNull();
      expect(document.activeElement).toBe(skills);
    } finally {
      view.unmount();
    }
  },
);

it.each([
  { options: { empty: true }, message: "Send a message to capture context usage.", retry: false },
  { options: { offline: true }, message: "Connect to the Gateway", retry: false },
  { options: { missing: true }, message: "No matching context report", retry: false },
  { options: { failure: true }, message: "Couldn't load the context breakdown", retry: true },
])("shows only the standard empty state for $message", async ({ options, message, retry }) => {
  const view = mountContextPage(report, options);
  try {
    await view.ready;
    flush();
    expect(view.container.textContent).toContain(message);
    expect(view.container.querySelector("openclaw-panel-empty-state")).not.toBeNull();
    expect(view.container.querySelector(".chat-context-page__header")).toBeNull();
    expect(view.container.querySelector(".chat-context__compact")).toBeNull();
    const button = view.container.querySelector<HTMLButtonElement>(
      "openclaw-panel-empty-state button",
    );
    expect(button?.textContent === "Retry").toBe(retry);
    expect(view.container.querySelector('[aria-label="Refresh"]')).toBeNull();
  } finally {
    view.unmount();
  }
});
