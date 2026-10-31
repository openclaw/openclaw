import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import type { ChatHistoryResult } from "../../pages/chat/chat-history-snapshot.ts";
import { copyToClipboard } from "../clipboard.ts";
import { showToast } from "../toast.ts";
import {
  canSplitSessionView,
  registerSessionSplitHost,
  runSessionNavigationAction,
  type SessionNavigationTarget,
} from "./session-menu-navigation.ts";

vi.mock("../clipboard.ts", () => ({ copyToClipboard: vi.fn(async () => true) }));
vi.mock("../toast.ts", () => ({ showToast: vi.fn() }));

const session = {
  key: "agent:research:dashboard:12345678-90ab-cdef-1234-567890abcdef",
  sessionId: "session-1",
};
const agent = { id: "research", name: "Research" };
const sessionPath = "/dashboard/research/dashboard/12345678-90ab-cdef-1234-567890abcdef";

let params: SessionNavigationTarget<RouteId>;
let request: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<ChatHistoryResult>>>;
beforeEach(() => {
  request = vi.fn<(...args: unknown[]) => Promise<ChatHistoryResult>>();
  const context = {
    basePath: "/control",
    agentSelection: { state: { selectedId: "research" } },
    agents: { state: { agentsList: { mainKey: "main", agents: [agent] } } },
    gateway: {
      connection: { gatewayUrl: `${window.location.origin.replace(/^http/u, "ws")}/control` },
      snapshot: {
        phase: "connected",
        client: { request },
        hello: {
          features: { methods: ["chat.history"] },
          auth: { role: "operator", scopes: ["operator.read"] },
        },
      },
    },
    sessions: { state: { result: { sessions: [{ ...session, boardFace: "dashboard" }] } } },
  } as unknown as ApplicationContext;
  params = { context, session, isCurrent: () => true };
});
const run = (kind: Parameters<typeof runSessionNavigationAction>[0]) =>
  runSessionNavigationAction(kind, params);
const copy = () => run("copy-markdown");
async function rejectCopy(errorMessage = t("sessionsView.copyTranscriptChanged")) {
  await copy();
  expect(copyToClipboard).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith({ message: errorMessage });
}

function page(messages: unknown[], extra: Partial<ChatHistoryResult> = {}): ChatHistoryResult {
  return { sessionId: session.sessionId, messages, totalMessages: 3, hasMore: false, ...extra };
}

function message(seq: number, content: string) {
  return { role: "assistant", content, __openclaw: { seq } };
}
const leaf = (activeLeafEntryId: string | null) =>
  ({ activeLeafEntryId }) as ChatHistoryResult["sessionInfo"];
function tailPage(extra: Partial<ChatHistoryResult> = {}) {
  return page([message(3, "Newest")], {
    hasMore: true,
    nextOffset: 1,
    deltaCursor: "stable-cursor",
    sessionInfo: leaf("leaf-3"),
    ...extra,
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([false, true])("copies credential-free session links (preview=%s)", async (preview) => {
  params.context.gateway.connection.gatewayUrl = "wss://gateway.example.test/remote?token=secret";
  await run(preview ? "copy-session-preview-link" : "copy-session-link");
  expect(copyToClipboard).toHaveBeenCalledWith(
    `https://gateway.example.test/remote${preview ? "/share" : ""}${sessionPath}`,
  );
});
it("keeps catalog preview targets without connection credentials", async () => {
  params.session = {
    key: "agent:research:catalog:codex:dev%3Amac:thread%2F123",
    sessionId: "catalog-session",
  };
  Object.assign(params.context.gateway.snapshot.hello!, {
    controlUiUrl: "https://gateway.example.test/remote?token=secret#private",
  });

  await run("copy-session-preview-link");

  expect(copyToClipboard).toHaveBeenCalledWith(
    "https://gateway.example.test/remote/share/chat/research?catalog=codex&host=dev%3Amac&thread=thread%2F123",
  );
});

it.each(["open-new-tab", "open-new-window"] as const)(
  "opens %s with a detached opener",
  async (kind) => {
    const opened = { opener: window, location: { replace: vi.fn() } };
    opened.location.replace.mockImplementation(() => expect(opened.opener).toBeNull());
    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);
    await run(kind);
    expect(opened.location.replace).toHaveBeenCalledWith(
      `${window.location.origin}/control${sessionPath}`,
    );
  },
);

it("reports popup blocking", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await run("open-new-window");
  expect(showToast).toHaveBeenCalledWith({ message: t("sessionsView.openWindowBlocked") });
});

it.each([null, "leaf-3"])(
  "copies coherent history chronologically with tail leaf %s",
  async (activeLeafEntryId) => {
    const first = message(1, "First response");
    const middle = message(2, "Middle response");
    const last = message(3, "Last response");
    const sessionInfo = leaf(activeLeafEntryId);
    request.mockResolvedValueOnce(
      page([middle, last], { hasMore: true, nextOffset: 1, sessionInfo }),
    );
    request.mockResolvedValueOnce(page([first, middle]));
    request.mockResolvedValueOnce(page([last], { sessionInfo }));

    await copy();

    const historyQuery = { sessionKey: session.key, agentId: "research", maxChars: 500_000 };
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      { ...historyQuery, limit: 1000, offset: 0 },
      { ...historyQuery, limit: 1000, offset: 1 },
      { ...historyQuery, limit: 1, offset: 0 },
    ]);
    const copied = (await vi.mocked(copyToClipboard).mock.calls[0]?.[0]) ?? "";
    expect(copyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining("First response"),
      expect.any(Function),
    );
    expect(copied).toContain("# Chat with Research");
    expect(copied.match(/Middle response/g)).toHaveLength(1);
    expect(copied.indexOf("First response")).toBeLessThan(copied.indexOf("Middle response"));
    expect(copied.indexOf("Middle response")).toBeLessThan(copied.indexOf("Last response"));
    expect(showToast).toHaveBeenCalledWith({ message: t("common.copied") });
  },
);

it.each(["operator.read", "operator.sessions.read", "operator.sessions.write"])(
  "copies only visible conversation messages with %s",
  async (scope) => {
    params.context.gateway.snapshot.hello!.auth!.scopes = [scope];
    request.mockResolvedValueOnce(
      page([
        message(1, "Visible response"),
        message(2, "NO_REPLY"),
        message(3, "HEARTBEAT_OK"),
        { role: "user", content: " " },
        {
          role: "toolResult",
          content:
            "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
        },
      ]),
    );
    await copy();
    const copied = (await vi.mocked(copyToClipboard).mock.calls[0]?.[0]) ?? "";
    expect(copied).toContain("Visible response");
    expect(copied).toContain("NO_REPLY");
    expect(copied).not.toMatch(/HEARTBEAT_OK|transcript repair|## You/);
  },
);

it.each([
  ["page", { sessionId: "replacement-session" }],
  ["page", { totalMessages: 4 }],
  ["page", { hasMore: true, nextOffset: 1 }],
  ["tail", { deltaCursor: "rewritten-cursor" }],
  ["tail", { sessionInfo: leaf("different-branch") }],
] as const)("rejects inconsistent or stalled history at %s: %j", async (stage, changed) => {
  const tail = tailPage();
  request.mockResolvedValueOnce(tail);
  request.mockResolvedValueOnce(
    page([message(1, "Oldest"), message(2, "Middle")], stage === "page" ? changed : {}),
  );
  request.mockResolvedValueOnce({ ...tail, ...(stage === "tail" ? changed : {}) });
  await rejectCopy();
});

it.each(["view", "connection", "pending"])(
  "fences transcript copies on %s changes",
  async (owner) => {
    let current = true;
    params.isCurrent = () => current;
    if (owner === "pending") {
      request.mockImplementationOnce(async () => {
        current = false;
        return page([message(1, "Wrong view")]);
      });
    }
    const pending = copy();
    if (owner === "view") {
      current = false;
    } else if (owner === "connection") {
      params.context.gateway.snapshot.client = null;
    }
    await pending;
    if (owner !== "pending") {
      expect(request).not.toHaveBeenCalled();
    }
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ message: t("sessionsView.copyTranscriptChanged") });
  },
);

it("denies transcript reads without a compatible read scope", async () => {
  params.context.gateway.snapshot.hello!.auth!.scopes = [];
  await rejectCopy(t("sessionsView.actionRequiresScope", { scope: "operator.sessions.read" }));
  expect(request).not.toHaveBeenCalled();
});

it("reports an empty transcript without replacing the clipboard", async () => {
  request.mockResolvedValueOnce(page([], { totalMessages: 0 }));
  await rejectCopy(t("chat.commandResults.emptyExport"));
});

it("uses the mounted chat owner's split capability and requires its handling receipt", async () => {
  expect(canSplitSessionView()).toBe(false);
  const chatPage = document.createElement("openclaw-chat-page");
  onTestFinished(registerSessionSplitHost(chatPage, () => true));
  document.body.append(chatPage);
  expect(canSplitSessionView()).toBe(true);
  const received = vi.fn((event: Event) => event.preventDefault());
  window.addEventListener(UI_COMMAND_EVENT, received);
  onTestFinished(() => window.removeEventListener(UI_COMMAND_EVENT, received));
  await run("split-below");
  const event = received.mock.calls[0]?.[0] as CustomEvent;
  expect(event.detail).toEqual({
    command: { kind: "split", direction: "down", sessionKey: session.key },
  });
  expect(showToast).not.toHaveBeenCalled();
  window.removeEventListener(UI_COMMAND_EVENT, received);
  await run("split-right");
  expect(showToast).toHaveBeenCalledWith({ message: t("sessionsView.splitUnavailable") });
});
