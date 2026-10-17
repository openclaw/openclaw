import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { consumeSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { StartedSessionNavigation } from "./started-session-navigation.ts";

type Fixture = ReturnType<typeof createDraftFixture>;
type Context = Fixture["context"];
const sessionKey = "agent:main:dashboard:0f403cb8-3920-4cf1-8eb7-79f2f00ce488";
const pathname = "/chat/main/0f403cb839204cf18eb779f2f00ce488";
const readyChat = async () => {
  queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
};
function created(context: Context, key = sessionKey) {
  vi.mocked(context.sessions.createResult).mockResolvedValue({
    key,
    initialRun: { status: "idle" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("confirmed session navigation", () => {
  it.each(["leave", "stop"] as const)(
    "settles a pending composer handoff when its route retires (%s)",
    async (retire) => {
      const { context } = createDraftFixture();
      await context.router.navigate("chat", context);
      const lifecycle = new AbortController();
      Object.defineProperty(context, "lifecycleAbortSignal", { value: lifecycle.signal });
      const navigation = new StartedSessionNavigation();
      let committed!: Promise<void>;
      vi.mocked(context.navigateAndWait).mockImplementation((routeId, options) => {
        committed = context.router.navigate(
          routeId,
          context,
          {},
          {
            pathname: options?.pathname ?? "/chat",
            search: options?.search ?? "",
            hash: options?.hash ?? "",
          },
        );
        return committed;
      });
      const opening = navigation.navigate(context, {
        client: context.gateway.snapshot.client!,
        key: "agent:main:dashboard:pending-composer",
        agentId: "main",
      });
      await committed;
      if (retire === "stop") {
        lifecycle.abort();
      } else {
        await context.router.navigate(
          "chat",
          context,
          {},
          {
            pathname: "/chat/main/another-session",
            search: "",
            hash: "",
          },
        );
      }
      await opening;
      expect(navigation.current).toBeNull();
      expect(context.navigateAndWait).toHaveBeenCalledOnce();
    },
  );

  it("hands off the confirmed session without waiting for speculative preloading", async () => {
    const { context, flow } = createDraftFixture();
    created(context);
    const preload = createDeferred();
    vi.mocked(context.preload).mockReturnValue(preload.promise);
    vi.mocked(context.navigateAndWait).mockImplementation(async (_routeId, options) => {
      expect(options?.pathname).toBe(pathname);
      expect(consumeSessionNavigationHandoff(context.gateway, pathname)).toBe(sessionKey);
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    flow.setMessage("start this task");
    const submission = flow.submit();
    try {
      await vi.waitFor(() => expect(context.navigateAndWait).toHaveBeenCalledOnce());
      await submission;
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      expect(flow.error).toBeNull();
    } finally {
      preload.resolve();
      await submission;
    }
  });

  it("surfaces navigation failure after a session has already been created", async () => {
    const { context, flow } = createDraftFixture();
    created(context, "agent:main:dashboard:created");
    vi.mocked(context.navigateAndWait)
      .mockRejectedValueOnce(new Error("Chat route failed to load"))
      .mockImplementationOnce(readyChat);
    flow.setMessage("start this task");

    await flow.submit();

    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    expect(flow.error).toBe("Chat route failed to load");
    expect(flow.submitting).toBe(false);
    expect(flow.pendingMessage?.content).toContainEqual({ type: "text", text: "start this task" });
    expect(flow.completedSubmission?.key).toBe("agent:main:dashboard:created");

    const readSignal = flow.attachmentDraft.reads.readSignal;
    flow.attachmentDraft.reads.updatePending(readSignal, 1);
    expect(flow.submitBlock()?.gate).toBe("attachment-reads");
    expect(flow.canSubmit()).toBe(false);
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    flow.attachmentDraft.reads.updatePending(readSignal, -1);

    expect(flow.canSubmit()).toBe(true);
    await flow.openSubmittedSession();

    expect(context.navigateAndWait).toHaveBeenCalledTimes(2);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(flow.error).toBeNull();
  });

  it("keeps a background prompt readable while scope is pending and opens without another create", async () => {
    const { context, flow } = createDraftFixture({
      request: async (method) => (method === "agent.wait" ? { status: "ok", endedAt: 1 } : {}),
    });
    const key = "agent:main:dashboard:background-visible";
    Object.assign(context.gateway.snapshot.client!, {
      recoveryScope: "",
      recoveryScopeReady: false,
    });
    delete context.gateway.snapshot.hello!.auth!.recoveryScope;
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key,
      initialRun: { status: "started", runId: "background-run" },
    });
    flow.setMessage("keep this background prompt visible");
    await flow.submit(undefined, true);
    expect(flow.message).toBe("");
    expect(flow.pendingMessage?.content).toContainEqual({
      type: "text",
      text: "keep this background prompt visible",
    });
    expect(flow.submitting).toBe(false);
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    Object.assign(context.gateway.snapshot.client!, {
      recoveryScope: "principal-a",
      recoveryScopeReady: true,
    });
    expect(flow.pendingMessage?.content).toContainEqual({
      type: "text",
      text: "keep this background prompt visible",
    });
    vi.mocked(context.navigateAndWait).mockImplementation(readyChat);
    await flow.openSubmittedSession();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    const auth = context.gateway.snapshot.hello!.auth!;
    auth.recoveryScope = "another-account";
    expect(flow.pendingMessage).toBeNull();
    await flow.openSubmittedSession();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
  });

  it.each([
    {
      scenario: "the Gateway handshake is replaced",
      retire: ({ context }: Fixture) => {
        const hello = context.gateway.snapshot.hello;
        if (hello) {
          context.gateway.snapshot.hello = { ...hello };
        }
      },
    },
    {
      scenario: "the Gateway client is replaced",
      retire: ({ context }: Fixture) => {
        const client = context.gateway.snapshot.client;
        if (client) {
          context.gateway.snapshot.client = new Proxy(client, {});
        }
      },
    },
    {
      scenario: "the pending navigation is retired",
      retire: ({ flow }: Fixture) => flow.invalidate(),
    },
  ])(
    "retires a confirmed session handoff when $scenario during session selection",
    async ({ retire }) => {
      const fixture = createDraftFixture();
      const { context, flow } = fixture;
      created(context);
      // Selection publishes synchronously; a subscriber may retire the flow
      // before navigation has claimed the confirmed key.
      vi.mocked(context.gateway.setSessionKey).mockImplementation((key) => {
        context.gateway.snapshot.sessionKey = key;
        retire(fixture);
      });
      flow.setMessage("keep this task on its original connection");

      await flow.submit();

      expect(consumeSessionNavigationHandoff(context.gateway, pathname)).toBeUndefined();
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      scenario: "the requested session visibility changes",
      retire: ({ flow }: Fixture) => flow.setVisibility("draft"),
    },
    {
      scenario: "the requested session capabilities change",
      retire: ({ capabilities }: Fixture) =>
        capabilities.setToolOverrides({ skills: { release: false } }),
    },
    {
      scenario: "the selected agent changes",
      retire: ({ place }: Fixture) => place.selectAgentId("other"),
    },
  ])("never retries a committed session after $scenario", async ({ retire }) => {
    const fixture = createDraftFixture({
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [
        { id: "main", workspace: "/workspace", model: { primary: "openai/test" } },
        { id: "other", workspace: "/workspace", model: { primary: "openai/test" } },
      ],
    });
    const { context, flow } = fixture;
    vi.mocked(context.sessions.createResult)
      .mockResolvedValueOnce({ key: "agent:main:dashboard:old", initialRun: { status: "idle" } })
      .mockImplementationOnce(async (params) => ({
        key: `agent:${params?.agentId ?? fixture.place.agentId}:dashboard:new`,
        initialRun: { status: "idle" },
      }));
    vi.mocked(context.navigateAndWait)
      .mockRejectedValueOnce(new Error("old navigation failed"))
      .mockImplementationOnce(readyChat);
    flow.setMessage("the committed task");
    await flow.submit();

    retire(fixture);
    expect(flow.canSubmit()).toBe(false);
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    flow.setMessage("a new task");
    await flow.submit();

    expect(context.sessions.createResult).toHaveBeenCalledTimes(2);
    expect(vi.mocked(context.sessions.createResult).mock.calls[1]?.[0]?.message).toBe("a new task");
    expect(context.gateway.snapshot.sessionKey).toBe(
      `agent:${fixture.place.agentId}:dashboard:new`,
    );
    expect(context.navigateAndWait).toHaveBeenCalledTimes(2);
  });
});
