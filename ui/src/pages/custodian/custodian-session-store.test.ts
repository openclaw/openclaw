/* @vitest-environment jsdom */

import { buildSystemAgentSessionInvalidatedErrorDetails } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { hasSensitiveConfigData } from "../../components/config-form.shared.ts";
import { installSafeLocalStorageForTesting } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import {
  publishPluginHelpContext,
  createPluginHelpRequest,
  currentPluginHelpReference,
} from "./plugin-help.ts";

describe("CustodianSessionStore", () => {
  beforeEach(() => {
    installSafeLocalStorageForTesting(window).clear();
  });

  afterEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it.each(["cold", "startup", "metadata"] as const)(
    "retains setting help through %s initialization until explicit submission",
    async (phase) => {
      const startup = deferred<never>();
      const request = vi
        .fn()
        .mockResolvedValue({ sessionId: "plugin-help-session", reply: "Ready.", action: "none" });
      if (phase !== "cold") {
        request.mockReturnValueOnce(startup.promise);
      }
      const { context, setPathname, setGatewaySnapshot } = createContext(request);
      setPathname("/settings/plugins/example");
      const plugin = { id: "example", name: "Example" };
      publishPluginHelpContext(context, {}, plugin, { overview: false, installed: true });
      const agentsList = context.agents.state.agentsList;
      if (phase === "metadata") {
        context.agents.state.agentsList = null;
      }
      const store = new CustodianSessionStore();
      if (phase !== "cold") {
        store.connect(context, "caretaker");
        store.setInput("Keep this draft.");
      }
      const setting =
        phase === "cold"
          ? {
              path: ["plugins", "entries", "example", "config", "names.with.dots"],
              label: "Names",
              value: ["first"],
            }
          : { path: ["limit"], label: "Limit", value: 5 };
      await createPluginHelpRequest(context, plugin)({ ...setting, sensitive: false });
      if (phase === "cold") {
        expect(request).not.toHaveBeenCalled();
        store.connect(context, "caretaker");
        await waitForFast(() => expect(store.canSend).toBe(true));
        expect(store.input).toBe('Explain Names\n\nCurrent value: ["first"]');
      } else {
        expect(store.input).toBe("Keep this draft.\n\nExplain Limit\n\nCurrent value: 5");
        expect(store.canSend).toBe(false);
        if (phase === "metadata") {
          expect(request).not.toHaveBeenCalled();
          context.agents.state.agentsList = agentsList;
          setGatewaySnapshot({});
          expect(store.input).toBe("Keep this draft.\n\nExplain Limit\n\nCurrent value: 5");
        }
        startup.reject(new Error("Fixture inference unavailable"));
        await waitForFast(() => expect(store.error).toContain("Fixture inference unavailable"));
        store.setInput(`${store.input}\nUse a brief answer.`);
        const edited = store.input;
        await store.send();
        expect(request).toHaveBeenCalledOnce();
        store.retry();
        await waitForFast(() => expect(store.canSend).toBe(true));
        expect(store.input).toBe(edited);
      }
      expect(request.mock.calls.every((call) => call[1].message === undefined)).toBe(true);
      const message = store.input;
      await store.send();
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
        sessionId: "plugin-help-session",
        message,
        context: { plugin: { ...plugin, setting: { path: setting.path, label: setting.label } } },
      });
    },
  );

  it("appends setting questions without overwriting an ordinary draft or a hosted secret answer", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ sessionId: "plugin-help-session", reply: "Ready.", action: "none" });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.canSend).toBe(true));
    store.setInput("Keep this ordinary draft.");
    store.sensitive = true;
    store.wizardInputPending = true;
    store.setInput("synthetic-answer");
    const plugin = { id: "example", name: "Example" };
    await createPluginHelpRequest(
      context,
      plugin,
    )({
      path: ["plugins", "entries", "example", "config", "apiKey"],
      label: "API key",
      value: "synthetic-secret",
      sensitive: true,
    });
    expect(store.input).toBe("synthetic-answer");
    expect(request).toHaveBeenCalledOnce();
    store.sensitive = false;
    store.wizardInputPending = false;
    store.setInput(store.input);
    expect(store.input).toBe(
      "Keep this ordinary draft.\n\nExplain API key\n\nCurrent value: <redacted>",
    );
  });

  it("masks nested sensitive values, references, sentinels and URL credentials in setting drafts", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ sessionId: "plugin-help-session", reply: "Ready.", action: "none" });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.canSend).toBe(true));
    const path = ["plugins", "entries", "example", "config", "accounts"];
    const hints = { "plugins.entries.example.config.accounts.*.opaque": { sensitive: true } };
    const values = [
      { work: { opaque: "nested-secret" } },
      { source: "env", provider: "default", id: "PRIVATE_KEY" },
      { value: "__OPENCLAW_REDACTED__" },
      "https://fixture-user:fixture-password@example.invalid/",
      "https://example.invalid/?access_token=fixture-token&safe=keep",
      { endpoints: ["https://example.invalid/#client_secret=fixture-secret"] },
      { "https://fixture-user:fixture-password@example.invalid/": "route" },
      "https://example.invalid/?next=https%3A%2F%2Fnested.invalid%2F%3Fapi_key%3Dfixture-key",
      "https%3A%2F%2Ffixture-user%3Afixture-password%40example.invalid%2F",
      `https://example.invalid/${"x".repeat(520)}?token=fixture-token`,
    ];
    for (const value of values) {
      const original = structuredClone(value);
      store.setInput("");
      await createPluginHelpRequest(context, { id: "example", name: "Example" })({
        path,
        label: "Accounts",
        value,
        sensitive: hasSensitiveConfigData(value, path, hints),
      });
      expect(store.input).toBe("Explain Accounts\n\nCurrent value: <redacted>");
      expect(value).toEqual(original);
    }
    const value = { endpoints: ["https://example.invalid/?region=eu&discount=100%25"] };
    const original = structuredClone(value);
    store.setInput("");
    await createPluginHelpRequest(context, { id: "example", name: "Example" })({
      path,
      label: "Accounts",
      value,
      sensitive: false,
    });
    expect(store.input).toContain(`Current value: ${JSON.stringify(original)}`);
    expect(value).toEqual(original);
  });

  it.each(["operator", "navigation"] as const)(
    "retires plugin references and pending drafts on %s change",
    async (change) => {
      const request = vi
        .fn()
        .mockResolvedValue({ sessionId: "plugin-help-session", reply: "Ready.", action: "none" });
      const { context, setGatewayToken, setPathname } = createContext(request);
      setPathname("/settings/plugins/example");
      const owner = {};
      const releaseOld = publishPluginHelpContext(
        context,
        owner,
        { id: "first", name: "First" },
        { overview: true, installed: true },
      );
      const plugin = { id: "second", name: "Second" };
      const releaseCurrent = publishPluginHelpContext(context, owner, plugin, {
        overview: true,
        installed: true,
      });
      releaseOld();
      expect(currentPluginHelpReference(context)?.id).toBe("second");
      const pending = createPluginHelpRequest(
        context,
        plugin,
      )({ path: ["limit"], label: "Limit", value: 5, sensitive: false });
      if (change === "operator") {
        await pending;
        setGatewayToken("replacement-operator");
      } else {
        setPathname("/agents");
        await pending;
      }
      expect(currentPluginHelpReference(context)).toBeUndefined();
      releaseCurrent();
      const store = new CustodianSessionStore();
      store.connect(context, "caretaker");
      await waitForFast(() => expect(store.canSend).toBe(true));
      expect(store.input).toBe("");
    },
  );

  it("shares one live session across repeated surface connections", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Ready.",
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Still here.",
        action: "none",
      });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    const firstSurfaceUpdates = vi.fn();
    const panelSurfaceUpdates = vi.fn();
    store.subscribe(firstSurfaceUpdates);
    store.subscribe(panelSurfaceUpdates);

    store.connect(context, "caretaker");
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    await store.send("Check this system");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "shared-session",
      message: "Check this system",
    });
    expect(store.messages.map((message) => message.text)).toEqual([
      "Ready.",
      "Check this system",
      "Still here.",
    ]);
    expect(store.hasRealUserTurn()).toBe(true);
    expect(firstSurfaceUpdates).toHaveBeenCalled();
    expect(panelSurfaceUpdates).toHaveBeenCalled();
  });

  it("reuses the persisted session id across store instances", async () => {
    const request = vi.fn((_method: string, params: { sessionId: string }) =>
      Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" }),
    );
    const { context } = createContext(request);

    new CustodianSessionStore().connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    const firstSessionId = request.mock.calls[0]?.[1].sessionId;
    expect(localStorage.getItem("openclaw.custodian.session.v1")).toBe(firstSessionId);

    new CustodianSessionStore().connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    expect(request.mock.calls[1]?.[1].sessionId).toBe(firstSessionId);
  });

  it.each([false, true])("remints an invalidated session (live=%s)", async (live) => {
    const ready = (_method: string, params: { sessionId: string }) =>
      Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" });
    const error = new GatewayRequestError({
      code: live ? "UNAVAILABLE" : "INVALID_REQUEST",
      message: live ? "OpenClaw session expired." : "OpenClaw session belongs to another caller.",
      details: buildSystemAgentSessionInvalidatedErrorDetails(),
    });
    const request = live
      ? vi
          .fn()
          .mockImplementationOnce(ready)
          .mockRejectedValueOnce(error)
          .mockImplementationOnce(ready)
      : vi.fn().mockRejectedValue(error);
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));
    const staleSessionId = request.mock.calls[0]?.[1].sessionId;
    if (live) {
      expect(store.messages.at(-1)?.text).toBe("Ready.");
      await store.send("Continue");
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
      const replacementSessionId = request.mock.calls[2]?.[1].sessionId;
      expect(replacementSessionId).not.toBe(staleSessionId);
      expect(localStorage.getItem("openclaw.custodian.session.v1")).toBe(replacementSessionId);
    } else {
      expect(localStorage.getItem("openclaw.custodian.session.v1")).not.toBe(staleSessionId);
      expect(store.canRetry()).toBe(true);
    }
  });

  it("refreshes durable history only while idle and coalesces concurrent reads", async () => {
    const pending = deferred<{
      turns: Array<{ role: "assistant" | "user"; text: string; at: number }>;
    }>();
    let historyCall = 0;
    const request = vi.fn((method: string, params: { sessionId?: string }) => {
      if (method === "openclaw.chat.history") {
        return ++historyCall === 1 ? Promise.resolve({ turns: [] }) : pending.promise;
      }
      return Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" });
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));

    const firstRefresh = store.refreshTranscriptIfIdle();
    const secondRefresh = store.refreshTranscriptIfIdle();
    expect(historyCall).toBe(2);
    pending.resolve({
      turns: [
        { role: "user", text: "Durable question", at: 10 },
        { role: "assistant", text: "Durable answer", at: 11 },
      ],
    });
    await Promise.all([firstRefresh, secondRefresh]);
    expect(store.messages.map((message) => message.text)).toEqual([
      "Durable question",
      "Durable answer",
    ]);
    const historyCallCount = request.mock.calls.filter(
      ([method]) => method === "openclaw.chat.history",
    ).length;

    store.sending = true;
    await store.refreshTranscriptIfIdle();
    store.sending = false;
    store.wizardInputPending = true;
    await store.refreshTranscriptIfIdle();
    store.wizardInputPending = false;
    store.messages = [
      {
        id: 1,
        role: "assistant",
        text: "Choose a repair",
        at: 12,
        question: {
          id: "repair",
          header: "Repair",
          question: "What should OpenClaw repair?",
          options: [{ label: "Gateway" }, { label: "Channel" }],
          isOther: false,
        },
        step: null,
      },
    ];
    await store.refreshTranscriptIfIdle();

    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.chat.history"),
    ).toHaveLength(historyCallCount);
    expect(store.messages[0]?.question?.id).toBe("repair");
  });

  it("keeps a transcript failure visible when a user turn invalidates its retry", async () => {
    const retry = deferred<{ turns: Array<{ role: "assistant"; text: string; at: number }> }>();
    const reply = deferred<{ sessionId: string; reply: string; action: "none" }>();
    let historyCall = 0;
    const request = vi.fn((method: string, params: { sessionId?: string; message?: string }) => {
      if (method === "openclaw.chat.history") {
        historyCall += 1;
        if (historyCall === 1) {
          return Promise.reject(new Error("history unavailable"));
        }
        return retry.promise;
      }
      if (params.message) {
        return reply.promise;
      }
      return Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" });
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));
    expect(store.transcript.status.error).toContain("history unavailable");

    const refresh = store.refreshTranscriptIfIdle();
    const send = store.send("Continue");
    retry.resolve({ turns: [{ role: "assistant", text: "Stale history", at: 2 }] });
    await refresh;

    expect(store.transcript.status.error).toContain("history unavailable");
    expect(store.messages.some((message) => message.text === "Stale history")).toBe(false);
    reply.resolve({ sessionId: "session-after-send", reply: "Continued.", action: "none" });
    await send;
  });

  it("refreshes durable history after reconnect and clears the abandoned outcome", async () => {
    const initialRequest = vi.fn(
      (
        method: string,
        params: { message?: string; sessionId?: string },
        options?: { signal?: AbortSignal },
      ) => {
        if (method === "openclaw.chat.history") {
          return Promise.resolve({ turns: [] });
        }
        if (params.message) {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
          });
        }
        return Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" });
      },
    );
    const { context, setGatewaySnapshot } = createContext(initialRequest, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));

    const interruptedSend = store.send("Finish the repair");
    await waitForFast(() => expect(store.sending).toBe(true));
    setGatewaySnapshot({ phase: "reconnecting", client: null });
    expect(store.abandonedTurnOutcomeUnknown).toBe(true);

    const liveStep = { id: "repair-step", type: "text", message: "Which channel?" };
    const reconnectRequest = vi.fn((method: string, params: { sessionId?: string }) => {
      if (method === "openclaw.chat.history") {
        return Promise.resolve({
          turns: [
            { role: "user", text: "Finish the repair", at: 20 },
            { role: "assistant", text: "Repair complete", at: 21 },
          ],
        });
      }
      if (method === "openclaw.chat") {
        // The full rejoin projects the authoritative live interaction.
        return Promise.resolve({
          sessionId: params.sessionId,
          reply: "Welcome back.",
          action: "none",
          wizardInputPending: true,
          step: liveStep,
        });
      }
      throw new Error(`Unexpected reconnect method: ${method}`);
    });
    setGatewaySnapshot({
      phase: "connected",
      client: { request: reconnectRequest } as unknown as GatewayBrowserClient,
    });
    await interruptedSend;
    // An unknown-outcome turn triggers a full rejoin, not just a history
    // refresh: the Gateway decides whether the answer was consumed and which
    // control is live now.
    await waitForFast(() =>
      expect(store.messages.at(-1)?.step).toMatchObject({ id: "repair-step" }),
    );
    expect(store.abandonedTurnOutcomeUnknown).toBe(false);
    expect(store.wizardInputPending).toBe(true);
    expect(store.messages.some((message) => message.text === "Repair complete")).toBe(true);
    expect(reconnectRequest.mock.calls.some(([method]) => method === "openclaw.chat")).toBe(true);
  });

  it("reconciles racing history even when the rejoin projects a live wizard", async () => {
    const step = { id: "live-step", type: "text", message: "Continue setup" };
    let historyCall = 0;
    const request = vi.fn((method: string, params: { sessionId?: string }) => {
      if (method === "openclaw.chat.history") {
        historyCall += 1;
        return Promise.resolve(
          historyCall === 1
            ? { turns: [] }
            : { turns: [{ role: "assistant", text: "Racing turn landed", at: 40 }] },
        );
      }
      return Promise.resolve({
        sessionId: params.sessionId,
        reply: "Welcome back.",
        action: "none",
        wizardInputPending: true,
        step,
      });
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    localStorage.setItem("openclaw.custodian.session.v1", "persisted-session-2");
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));

    // A projected live control must not skip the racing-history barrier: the
    // reconciled rows render beneath the answerable wizard step.
    expect(historyCall).toBe(2);
    expect(store.messages.some((message) => message.text === "Racing turn landed")).toBe(true);
    expect(store.messages.at(-1)?.step).toMatchObject({ id: "live-step" });
    expect(store.wizardInputPending).toBe(true);
  });

  it.each([
    new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "The configured runtime could not start. Repair the launcher and retry.",
      details: { code: "system_agent_inference_unavailable" },
    }),
    new Error("The greeting could not start. Retry after repairing the runtime."),
    new Error("OPENAI_API_KEY=sk-1234567890abcdef"),
  ])(
    "keeps startup failures in the conversation and blocks sends until verified: %s",
    async (error) => {
      const displayed = error.message.startsWith("OPENAI_API_KEY=")
        ? "OPENAI_API_KEY=sk-123...cdef"
        : error.message;
      const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Ready.",
        action: "none",
      });
      const { context } = createContext(request);
      const store = new CustodianSessionStore();

      store.connect(context, "caretaker");
      await waitForFast(() => expect(store.error).toBe(displayed));
      expect(store.setupRequired).toBe(false);
      await expect(store.send("should not send")).resolves.toBe("rejected");
      expect(request).toHaveBeenCalledOnce();

      store.setInput("Keep my draft");
      store.retry();
      await waitForFast(() => expect(store.messages.at(-1)?.text).toBe("Ready."));
      expect(store.input).toBe("Keep my draft");
      expect(request.mock.calls[1]?.[1]).not.toHaveProperty("message");
      expect(store.error).toBeNull();
    },
  );

  it.each([
    { edits: [], expected: "Original question" },
    { edits: ["New question"], expected: "New question" },
    { edits: ["New question", ""], expected: "" },
  ])(
    "preserves the latest ordinary draft after an unsent failure: $edits",
    async ({ edits, expected }) => {
      const pending = deferred();
      const request = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "draft-session", reply: "Ready." })
        .mockImplementationOnce(() =>
          pending.promise.then(() => {
            throw new Error("Request was not sent.");
          }),
        );
      const { context } = createContext(request);
      const store = new CustodianSessionStore();
      store.connect(context, "caretaker");
      await waitForFast(() => expect(store.canSend).toBe(true));
      store.setInput("Original question");
      const sending = store.send();
      expect(store.input).toBe("");
      for (const edit of edits) {
        store.setInput(edit);
      }
      pending.resolve();
      await expect(sending).resolves.toBe("rejected");
      expect(store.input).toBe(expected);
      expect(store.hasRealUserTurn()).toBe(false);
      expect(store.error).toBe("Request was not sent.");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("rechecks failed inference without replaying a user turn", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Ready.",
        action: "none",
      })
      .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
        options?.onSent?.();
        return Promise.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Runtime verification failed.",
            details: { code: "system_agent_inference_unavailable" },
          }),
        );
      })
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Recovered.",
        action: "none",
      });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));
    await store.send("Check this system");
    expect(store.error).toBe("Runtime verification failed.");
    expect(store.messages.map((message) => message.text)).toContain("Check this system");
    await expect(store.send("Do not send yet")).resolves.toBe("rejected");
    store.setInput("Next question");
    store.retry();
    await waitForFast(() => expect(store.messages.at(-1)?.text).toBe("Recovered."));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(store.messages.map((message) => message.text)).toContain("Check this system");
    expect(store.input).toBe("Next question");
  });

  it.each([false, true])(
    "requires a primary model while allowing an explicit setup utility (%s)",
    async (utility) => {
      const request = vi.fn();
      if (utility) {
        request.mockResolvedValue({
          sessionId: "utility-setup-session",
          reply: "Choose a primary model for your agent.",
          action: "none",
        });
      }
      const { context } = createContext(request, ["openclaw.chat"], {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", ...(utility ? { utilityModel: "local/setup" } : {}) }],
        },
      });
      const store = new CustodianSessionStore();
      store.connect(context, utility ? "onboarding" : "caretaker");
      if (!utility) {
        expect(store.setupRequired).toBe(true);
        expect(store.sending).toBe(false);
        expect(request).not.toHaveBeenCalled();
        await expect(store.send("should not send")).resolves.toBe("rejected");
        return;
      }
      await waitForFast(() => expect(store.messages.at(-1)?.text).toContain("Choose a primary"));
      expect(store.setupRequired).toBe(false);
      expect(store.canSend).toBe(true);
      expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "onboarding" });
      expect(context.agents.state.agentsList?.agents[0]?.model?.primary).toBeUndefined();
      store.exitSetup();
      expect(context.navigate).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
    },
  );

  it.each(["chat", "channels", "model-setup"] as const)(
    "prevents late replies from navigating away from %s",
    async (destination) => {
      const reply = deferred<unknown>();
      let requestSignal: AbortSignal | undefined;
      const pendingRequest = (
        _method: string,
        _params: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        requestSignal = options?.signal;
        return reply.promise;
      };
      const request =
        destination === "chat"
          ? vi
              .fn()
              .mockImplementationOnce(pendingRequest)
              .mockReturnValue(new Promise(() => {}))
          : vi.fn(pendingRequest);
      const { context } = createContext(request);
      const store = new CustodianSessionStore();
      store.connect(context, destination === "model-setup" ? "caretaker" : "onboarding");
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      if (destination === "channels") {
        store.openChannelsFromOnboarding();
      } else {
        store.exitSetup(destination);
      }
      expect(requestSignal?.aborted).toBe(true);
      expect(store.sending).toBe(false);
      if (destination === "chat") {
        store.connect(context, "caretaker");
        await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      }
      reply.resolve({
        sessionId: "late-session",
        reply: "Your agent is ready.",
        action: "open-agent",
        agentId: "main",
        agentDraft: "hatch",
      });
      await Promise.resolve();
      expect(context.navigate).toHaveBeenCalledTimes(1);
      expect(context.navigate).toHaveBeenCalledWith(destination);
      expect(context.agents.refreshList).not.toHaveBeenCalled();
      if (destination === "chat") {
        expect(store.messages).toEqual([]);
      }
      if (destination === "channels") {
        expect(store.canRetry()).toBe(false);
      }
    },
  );

  it("accepts new event nudges after a conversation variant rotates", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "shared-session",
      reply: "Ready.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    expect(store.eventNudge).not.toBeNull();
    store.dismissEventNudge();
    expect(store.eventNudge).toBeNull();

    store.connect(context, "onboarding");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });

    expect(store.eventNudge).not.toBeNull();
  });
});
