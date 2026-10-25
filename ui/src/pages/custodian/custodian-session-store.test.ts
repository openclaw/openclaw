/* @vitest-environment jsdom */

import {
  buildSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatResult as ChatResult,
  type SystemAgentChatHistoryResult as History,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { hasSensitiveConfigData } from "../../components/config-form.shared.ts";
import { QUICK_ACTIONS_QUESTION } from "../../test-helpers/custodian-quick-actions.ts";
import { installSafeLocalStorageForTesting } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import {
  publishPluginHelpContext,
  createPluginHelpRequest,
  currentPluginHelpReference,
} from "./plugin-help.ts";

const plugin = { id: "example", name: "Example" };
const inferenceDetails = { code: "system_agent_inference_unavailable" };
const inferenceFailure = (message: string) =>
  new GatewayRequestError({ code: "UNAVAILABLE", message, details: inferenceDetails });
const reloadFailure = { configReload: { hotReloadStatus: "disabled" }, channels: {} };
const historyMethod = "openclaw.chat.history";
const historyMethods = ["openclaw.chat", historyMethod];
type ChatParams = { sessionId?: string; message?: string };
type RequestOptions = { signal?: AbortSignal };
type RequestArgs = [method: string, params: ChatParams, options?: RequestOptions];
type Context = ReturnType<typeof createContext>["context"];
const echoReply = (_method: string, params: ChatParams) =>
  Promise.resolve(chatReply(params.sessionId));
const configPath = ["plugins", "entries", "example", "config"];
const settings = {
  Names: [...configPath, "names.with.dots"],
  Limit: ["limit"],
  "API key": [...configPath, "apiKey"],
  Accounts: [...configPath, "accounts"],
};
const publish = (context: Context, owner: object, current = plugin) =>
  publishPluginHelpContext(context, owner, current, { installed: true });
type Setting = keyof typeof settings;
function ask(context: Context, label: Setting, value: unknown, sensitive = false, target = plugin) {
  const request = createPluginHelpRequest(context, target);
  return request({ path: settings[label], label, value, sensitive });
}
function historyRequest(
  read: () => Promise<History>,
  send: (params: ChatParams, options?: RequestOptions) => unknown = (params) =>
    Promise.resolve(chatReply(params.sessionId)),
) {
  return vi.fn((method: string, params: ChatParams, options?: RequestOptions) =>
    method === historyMethod ? read() : send(params, options),
  );
}
function history(...turns: Array<["user" | "assistant", string, number]>): History {
  return { turns: turns.map(([role, text, at]) => ({ role, text, at })) };
}
const text = (store: CustodianSessionStore) => store.messages.map((message) => message.text);
function chatReply<T extends string | undefined>(sessionId: T, reply = "Ready.") {
  return { sessionId, reply, action: "none" as const };
}
function setupStore(
  request = vi.fn().mockResolvedValue(chatReply("plugin-help-session")),
  variant: Parameters<CustodianSessionStore["connect"]>[1] = "caretaker",
  methods = ["openclaw.chat"],
  options: Parameters<typeof createContext>[2] = {},
) {
  const harness = createContext(request, methods, options);
  const store = new CustodianSessionStore();
  store.connect(harness.context, variant);
  return { ...harness, store, request };
}
function healthFixture(healthRequest: Parameters<typeof createContext>[0], onboarding = false) {
  const request = vi.fn().mockResolvedValue({ sessionId: "health-session", action: "none" });
  const variant = onboarding ? "onboarding" : "caretaker";
  return setupStore(request, variant, undefined, { healthRequest });
}

beforeEach(() => installSafeLocalStorageForTesting(window).clear());
afterEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

it.each(["cold", "startup", "metadata"] as const)("retains %s drafts", async (phase) => {
  const startup = deferred<never>();
  const request = vi.fn().mockResolvedValue(chatReply("plugin-help-session"));
  if (phase !== "cold") {
    request.mockReturnValueOnce(startup.promise);
  }
  const { context, setPathname, setGatewaySnapshot } = createContext(request);
  setPathname("/settings/plugins/example");
  publish(context, {}, plugin);
  const agentsList = context.agents.state.agentsList;
  if (phase === "metadata") {
    context.agents.state.agentsList = null;
  }
  const store = new CustodianSessionStore();
  if (phase !== "cold") {
    store.connect(context, "caretaker");
    store.setInput("Keep this draft.");
  }
  const label = phase === "cold" ? "Names" : "Limit";
  await ask(context, label, phase === "cold" ? ["first"] : 5);
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
    await store.retry();
    await waitForFast(() => expect(store.canSend).toBe(true));
    expect(store.input).toBe(edited);
  }
  expect(request.mock.calls.every((call) => call[1].message === undefined)).toBe(true);
  const message = store.input;
  await store.send();
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
    sessionId: "plugin-help-session",
    message,
    context: { plugin: { ...plugin, setting: { path: settings[label], label } } },
  });
});

it("keeps setting drafts separate from hosted secret answers", async () => {
  const { request, context, store } = setupStore();
  await waitForFast(() => expect(store.canSend).toBe(true));
  store.setInput("Keep this ordinary draft.");
  store.sensitive = true;
  store.wizardInputPending = true;
  store.setInput("synthetic-answer");
  await ask(context, "API key", "synthetic-secret", true);
  expect(store.input).toBe("synthetic-answer");
  expect(request).toHaveBeenCalledOnce();
  store.sensitive = false;
  store.wizardInputPending = false;
  store.setInput(store.input);
  expect(store.input).toBe(
    "Keep this ordinary draft.\n\nExplain API key\n\nCurrent value: <redacted>",
  );
});

it("redacts nested secrets, references, sentinels and credential URLs", async () => {
  const { context, store } = setupStore();
  await waitForFast(() => expect(store.canSend).toBe(true));
  const path = settings.Accounts;
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
    await ask(context, "Accounts", value, hasSensitiveConfigData(value, path, hints));
    expect(store.input).toBe("Explain Accounts\n\nCurrent value: <redacted>");
    expect(value).toEqual(original);
  }
  const value = { endpoints: ["https://example.invalid/?region=eu&discount=100%25"] };
  const original = structuredClone(value);
  store.setInput("");
  await ask(context, "Accounts", value);
  expect(store.input).toContain(`Current value: ${JSON.stringify(original)}`);
  expect(value).toEqual(original);
});

it.each(["operator", "navigation"] as const)("retires %s plugin context", async (change) => {
  const request = vi.fn().mockResolvedValue(chatReply("plugin-help-session"));
  const { context, setGatewayToken, setPathname } = createContext(request);
  setPathname("/settings/plugins/example");
  const owner = {};
  const releaseOld = publish(context, owner, { id: "first", name: "First" });
  const currentPlugin = { id: "second", name: "Second" };
  const releaseCurrent = publish(context, owner, currentPlugin);
  releaseOld();
  expect(currentPluginHelpReference(context)?.id).toBe("second");
  const pending = ask(context, "Limit", 5, false, currentPlugin);
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
});

it("shares and persists one session across surfaces and stores", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(chatReply("shared-session"))
    .mockResolvedValueOnce(chatReply("shared-session", "Still here."))
    .mockImplementationOnce(echoReply);
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
  expect(text(store)).toEqual(["Ready.", "Check this system", "Still here."]);
  expect(store.hasRealUserTurn()).toBe(true);
  expect(firstSurfaceUpdates).toHaveBeenCalled();
  expect(panelSurfaceUpdates).toHaveBeenCalled();
  expect(localStorage.getItem("openclaw.custodian.session.v1")).toBe("shared-session");
  new CustodianSessionStore().connect(context, "caretaker");
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[2]?.[1].sessionId).toBe("shared-session");
});

it.each([false, true])("remints an invalidated session (live=%s)", async (live) => {
  const error = new GatewayRequestError({
    code: live ? "UNAVAILABLE" : "INVALID_REQUEST",
    message: live ? "OpenClaw session expired." : "OpenClaw session belongs to another caller.",
    details: buildSystemAgentSessionInvalidatedErrorDetails(),
  });
  const request = live
    ? vi
        .fn()
        .mockImplementationOnce(echoReply)
        .mockRejectedValueOnce(error)
        .mockImplementationOnce(echoReply)
    : vi.fn().mockRejectedValue(error);
  const { store } = setupStore(request);
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

it.each(["coalesced", "invalidated"] as const)("settles %s history reads", async (mode) => {
  const pending = deferred<History>();
  const reply = deferred<ChatResult>();
  const invalidated = mode === "invalidated";
  let historyCall = 0;
  const request = historyRequest(
    () =>
      ++historyCall === 1
        ? invalidated
          ? Promise.reject(new Error("history unavailable"))
          : Promise.resolve({ turns: [] })
        : pending.promise,
    (params) =>
      invalidated && params.message ? reply.promise : Promise.resolve(chatReply(params.sessionId)),
  );
  const { store } = setupStore(request, undefined, historyMethods);
  await waitForFast(() => expect(store.sending).toBe(false));
  if (invalidated) {
    expect(store.transcript.status.error).toContain("history unavailable");
  }
  const refresh = store.refreshTranscriptIfIdle();
  const joined = invalidated ? null : store.refreshTranscriptIfIdle();
  const send = invalidated ? store.send("Continue") : null;
  expect(historyCall).toBe(2);
  pending.resolve(
    invalidated
      ? history(["assistant", "Stale history", 2])
      : history(["user", "Durable question", 10], ["assistant", "Durable answer", 11]),
  );
  await Promise.all([refresh, joined]);
  if (invalidated) {
    expect(store.transcript.status.error).toContain("history unavailable");
    expect(text(store)).not.toContain("Stale history");
    reply.resolve(chatReply("session-after-send", "Continued."));
    await send;
    return;
  }
  expect(text(store)).toEqual(["Durable question", "Durable answer"]);
  const reads = request.mock.calls.filter(([method]) => method === historyMethod).length;
  store.sending = true;
  await store.refreshTranscriptIfIdle();
  store.sending = false;
  store.wizardInputPending = true;
  await store.refreshTranscriptIfIdle();
  store.wizardInputPending = false;
  store.messages = [
    {
      ...store.messages[1]!,
      question: { ...QUICK_ACTIONS_QUESTION, id: "repair", isOther: false },
    },
  ];
  await store.refreshTranscriptIfIdle();
  expect(request.mock.calls.filter(([method]) => method === historyMethod)).toHaveLength(reads);
  expect(store.messages[0]?.question?.id).toBe("repair");
});

it("rejoins abandoned turns with authoritative history and controls", async () => {
  const initialRequest = historyRequest(
    () => Promise.resolve({ turns: [] }),
    (params, options) =>
      params.message
        ? new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
          })
        : Promise.resolve(chatReply(params.sessionId)),
  );
  const { store, setGatewaySnapshot } = setupStore(initialRequest, undefined, historyMethods);
  await waitForFast(() => expect(store.sending).toBe(false));

  const interruptedSend = store.send("Finish the repair");
  await waitForFast(() => expect(store.sending).toBe(true));
  setGatewaySnapshot({ phase: "reconnecting", client: null });
  expect(store.abandonedTurnOutcomeUnknown).toBe(true);
  const liveStep = { id: "repair-step", type: "text", message: "Which channel?" };
  const reconnectRequest = vi.fn((method: string, params: ChatParams) => {
    const replies: Record<string, unknown> = {
      health: { channels: {} },
      [historyMethod]: history(
        ["user", "Finish the repair", 20],
        ["assistant", "Repair complete", 21],
      ),
      "openclaw.chat": {
        ...chatReply(params.sessionId, "Welcome back."),
        wizardInputPending: true,
        step: liveStep,
      },
    };
    if (!Object.hasOwn(replies, method)) {
      throw new Error(`Unexpected reconnect method: ${method}`);
    }
    return Promise.resolve(replies[method]);
  });
  setGatewaySnapshot({
    phase: "connected",
    client: { request: reconnectRequest } as unknown as GatewayBrowserClient,
  });
  await interruptedSend;
  await waitForFast(() => expect(store.messages.at(-1)?.step).toMatchObject({ id: "repair-step" }));
  expect(store).toMatchObject({ abandonedTurnOutcomeUnknown: false, wizardInputPending: true });
  expect(text(store)).toContain("Repair complete");
  expect(reconnectRequest.mock.calls.some(([method]) => method === "openclaw.chat")).toBe(true);
});

it.each([
  [inferenceFailure("The runtime could not start."), false],
  [new Error("The greeting could not start."), false],
  [new Error("OPENAI_API_KEY=sk-1234567890abcdef"), false],
  [inferenceFailure("Runtime verification failed."), true],
] as const)("verifies inference: %s (live=%s)", async (error, live) => {
  const displayed = error.message.startsWith("OPENAI_API_KEY=")
    ? "OPENAI_API_KEY=sk-123...cdef"
    : error.message;
  const request = vi.fn();
  if (live) {
    request.mockResolvedValueOnce(chatReply("shared-session"));
  }
  request
    .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
      if (live) {
        options?.onSent?.();
      }
      return Promise.reject(error);
    })
    .mockResolvedValueOnce(chatReply("shared-session", live ? "Recovered." : "Ready."));
  const { store } = setupStore(request);
  if (live) {
    await waitForFast(() => expect(store.sending).toBe(false));
    await store.send("Check this system");
    expect(text(store)).toContain("Check this system");
  } else {
    await waitForFast(() => expect(store.error).toBe(displayed));
  }
  expect(store).toMatchObject({ error: displayed, setupRequired: false });
  await expect(store.send("should not send")).resolves.toBe("rejected");
  expect(request).toHaveBeenCalledTimes(live ? 2 : 1);
  const draft = live ? "Next question" : "Keep my draft";
  store.setInput(draft);
  await store.retry();
  await waitForFast(() => expect(store.messages.at(-1)?.text).toBe(live ? "Recovered." : "Ready."));
  expect(store).toMatchObject({ input: draft, error: null });
  expect(request).toHaveBeenCalledTimes(live ? 3 : 2);
  expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("message");
  if (live) {
    expect(text(store)).toContain("Check this system");
  }
});

it.each([
  { edits: [], expected: "Original question" },
  { edits: ["New question"], expected: "New question" },
  { edits: ["New question", ""], expected: "" },
])("retains the latest unsent draft: $edits", async ({ edits, expected }) => {
  const pending = deferred();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ sessionId: "draft-session", reply: "Ready." })
    .mockImplementationOnce(() =>
      pending.promise.then(() => {
        throw new Error("Request was not sent.");
      }),
    );
  const { store } = setupStore(request);
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
});

it.each([false, true])("allows only configured models or setup utilities (%s)", async (utility) => {
  const request = vi.fn();
  if (utility) {
    request.mockResolvedValue(
      chatReply("utility-setup-session", "Choose a primary model for your agent."),
    );
  }
  const { context } = createContext(request);
  context.agents.state.agentsList!.agents = [
    { id: "main", ...(utility ? { utilityModel: "local/setup" } : {}) },
  ];
  const store = new CustodianSessionStore();
  store.connect(context, utility ? "onboarding" : "caretaker");
  if (!utility) {
    expect(store).toMatchObject({ setupRequired: true, sending: false });
    expect(request).not.toHaveBeenCalled();
    await expect(store.send("should not send")).resolves.toBe("rejected");
    return;
  }
  await waitForFast(() => expect(store.messages.at(-1)?.text).toContain("Choose a primary"));
  expect(store).toMatchObject({ setupRequired: false, canSend: true });
  expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "onboarding" });
  expect(context.agents.state.agentsList?.agents[0]?.model?.primary).toBeUndefined();
  store.exitSetup();
  expect(context.navigate).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
});

it.each(["chat", "channels", "model-setup"] as const)("leaves for %s", async (destination) => {
  const reply = deferred<unknown>();
  const request = vi.fn((..._args: RequestArgs) => reply.promise);
  if (destination === "chat") {
    request.mockReturnValueOnce(reply.promise).mockReturnValue(new Promise(() => {}));
  }
  const variant = destination === "model-setup" ? "caretaker" : "onboarding";
  const { context, store } = setupStore(request, variant);
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());
  if (destination === "channels") {
    store.openChannelsFromOnboarding();
  } else {
    store.exitSetup(destination);
  }
  expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
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
});

it("refreshes health across activation, reconnect and variant changes", async () => {
  const healthRequest = vi.fn().mockResolvedValue(reloadFailure);
  const fixture = healthFixture(healthRequest, true);
  const { context, store, request, setGatewaySnapshot, emitGatewayEvent } = fixture;
  const client = context.gateway.snapshot.client;
  expect(healthRequest).not.toHaveBeenCalled();
  store.connect(context, "caretaker");
  await waitForFast(() => expect(store.eventNudge?.kind).toBe("config-reload"));
  store.connect(context, "caretaker");
  setGatewaySnapshot({});
  expect(healthRequest).toHaveBeenCalledOnce();
  healthRequest.mockResolvedValue({ channels: {} });
  setGatewaySnapshot({ phase: "reconnecting", client: null });
  setGatewaySnapshot({ phase: "connected", client });
  await waitForFast(() => expect(store.eventNudge).toBeNull());
  expect(healthRequest).toHaveBeenCalledTimes(2);
  const before = request.mock.calls.length;
  emitGatewayEvent({ event: "health", payload: reloadFailure });
  expect(store.eventNudge).not.toBeNull();
  store.dismissEventNudge();
  expect(store.eventNudge).toBeNull();
  store.connect(context, "onboarding");
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(before + 1));
  store.connect(context, "caretaker");
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(before + 2));
  emitGatewayEvent({ event: "health", payload: reloadFailure });
  expect(store.eventNudge).not.toBeNull();
});

it("retries failed health on tick, then stops polling", async () => {
  const initialHealth = deferred<unknown>();
  const healthRequest = vi
    .fn()
    .mockReturnValueOnce(initialHealth.promise)
    .mockResolvedValue(reloadFailure);
  const { store, emitGatewayEvent } = healthFixture(healthRequest);
  emitGatewayEvent({ event: "tick", payload: {} });
  expect(healthRequest).toHaveBeenCalledOnce();

  initialHealth.reject(new Error("Temporary health failure"));
  await initialHealth.promise.catch(() => undefined);
  await Promise.resolve();
  expect(healthRequest).toHaveBeenCalledOnce();
  emitGatewayEvent({ event: "tick", payload: {} });
  await waitForFast(() => expect(store.eventNudge?.kind).toBe("config-reload"));
  emitGatewayEvent({ event: "tick", payload: {} });
  expect(healthRequest).toHaveBeenCalledTimes(2);
});

it.each(["event", "reconnect", "variant", "operator"] as const)(
  "rejects %s stale health",
  async (change) => {
    const pending = deferred<unknown>();
    const healthRequest = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ channels: {} });
    const { context, store, emitGatewayEvent, setGatewaySnapshot, setGatewayToken } =
      healthFixture(healthRequest);
    await waitForFast(() => expect(healthRequest).toHaveBeenCalledOnce());
    if (change === "event") {
      emitGatewayEvent({ event: "health", payload: { channels: {} } });
    } else if (change === "reconnect") {
      const client = context.gateway.snapshot.client;
      setGatewaySnapshot({ phase: "reconnecting", client: null });
      setGatewaySnapshot({ phase: "connected", client });
    } else if (change === "variant") {
      store.connect(context, "onboarding");
    } else {
      setGatewayToken("replacement-operator");
      setGatewaySnapshot({});
    }
    pending.resolve(reloadFailure);
    await pending.promise;
    expect(store.eventNudge).toBeNull();
  },
);
