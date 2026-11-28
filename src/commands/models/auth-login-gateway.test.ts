import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import type { WizardNextResult, WizardStep } from "../../../packages/gateway-protocol/src/index.js";
import {
  GatewayLocalBackendSharedAuthUnavailableError,
  type GatewayRequestFunction,
} from "../../gateway/call.js";
import { GatewayTransportError } from "../../gateway/transport-error.js";
import { resolveManifestDeclaredProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { readGatewayLoginParams, runGatewayLoginWizard } from "./auth-login-gateway.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";

const prompts = vi.hoisted(() => ({ note: vi.fn(), text: vi.fn(), select: vi.fn() }));
const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  isImplicitLocalGatewayTarget: vi.fn(),
}));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
  isImplicitLocalGatewayTarget: gatewayMocks.isImplicitLocalGatewayTarget,
}));
// mock-isolation: Exercise remote step handling without reading the test runner's terminal.
vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: (_output: unknown, signal: AbortSignal) => ({
    ...prompts,
    text: (options: Record<string, unknown>) => prompts.text(options, signal),
  }),
}));
// mock-isolation: Keep provider selection deterministic without scanning installed plugins.
vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeclaredProviderAuthChoices: vi.fn(() => [
    {
      pluginId: "openai",
      providerId: "openai",
      methodId: "api-key",
      choiceId: "openai-api-key",
      choiceLabel: "OpenAI API key",
      appGuidedSecret: true,
    },
    {
      pluginId: "openai",
      providerId: "openai",
      methodId: "oauth",
      choiceId: "openai",
      choiceLabel: "Codex login",
      appGuidedAuth: "device-code",
      credentialOnly: true,
    },
  ]),
}));
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv;
const next = (stepId?: string, value?: unknown) => ({
  method: "wizard.next",
  params: { sessionId: "login", ...(stepId ? { answer: { stepId, value } } : {}) },
});
const step = (value: WizardStep): WizardNextResult => ({ done: false, step: value });
const authUrl = "https://example.test/authorize";
const browserStep = step({ id: "code", type: "text", externalUrl: authUrl });
const done: WizardNextResult = { done: true, status: "done" };
function gateway(results: Array<WizardNextResult | Error>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request: GatewayRequestFunction = async <T>(method: string, params?: unknown) => {
    calls.push({ method, params });
    const result = method === "wizard.cancel" ? { status: "cancelled" } : results.shift();
    if (!result || result instanceof Error) {
      throw result ?? new Error("Unexpected wizard request");
    }
    return result as T;
  };
  return {
    calls,
    run: () => runGatewayLoginWizard(request, "login", new AbortController().signal, runtime),
  };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  gatewayMocks.callGateway.mockReset();
  gatewayMocks.isImplicitLocalGatewayTarget.mockResolvedValue(true);
});

async function expectRefresh(
  outcome: Awaited<ReturnType<typeof refreshRunningGatewayAuthState>>,
  warning?: string,
  operation: "login" | "update" = "login",
) {
  const result = await refreshRunningGatewayAuthState("main", operation, runtime);
  expect({ result, warnings: runtime.error.mock.calls }).toEqual({
    result: outcome,
    warnings: warning ? [[warning]] : [],
  });
}

it("maps normalized API-key method and agent to the exact plugin choice", async () => {
  const opts = { provider: "OpenAI", method: "API-KEY", agent: "writer" };
  await expect(
    readGatewayLoginParams(opts, "login", new AbortController().signal),
  ).resolves.toEqual({
    sessionId: "login",
    authChoice: "openai/openai-api-key",
    agentId: "writer",
  });
  expect(prompts.select).not.toHaveBeenCalled();
});

it("offers searchable sign-in choices in label order across plugin discovery groups", async () => {
  const choice = (pluginId: string, choiceLabel: string) => ({
    pluginId,
    providerId: pluginId,
    methodId: "api-key",
    choiceId: `${pluginId}-key`,
    choiceLabel,
    appGuidedSecret: true as const,
  });
  vi.mocked(resolveManifestDeclaredProviderAuthChoices).mockReturnValueOnce([
    choice("zeta", "Zeta API key"),
    choice("beta-second", "Beta API key"),
    choice("alpha", "Alpha API key"),
    choice("beta-first", "Beta API key"),
  ]);
  prompts.select.mockResolvedValueOnce("beta-first/beta-first-key");

  await expect(
    readGatewayLoginParams({ agent: "writer" }, "login", new AbortController().signal),
  ).resolves.toEqual({
    sessionId: "login",
    authChoice: "beta-first/beta-first-key",
    agentId: "writer",
  });
  expect(prompts.select).toHaveBeenCalledWith({
    message: "Choose a provider sign-in method",
    searchable: true,
    options: [
      { value: "alpha/alpha-key", label: "Alpha API key", hint: "alpha / api-key" },
      { value: "beta-first/beta-first-key", label: "Beta API key", hint: "beta-first / api-key" },
      {
        value: "beta-second/beta-second-key",
        label: "Beta API key",
        hint: "beta-second / api-key",
      },
      { value: "zeta/zeta-key", label: "Zeta API key", hint: "zeta / api-key" },
    ],
  });
});

it("keeps preferred providers together with their method priorities and descriptions", async () => {
  const openaiChoices = [
    [
      "api-key",
      "openai-api-key",
      "OpenAI API Key",
      "Use your OpenAI API key directly",
      5,
      undefined,
    ],
    [
      "siwc",
      "openai-token-sharing",
      "Sign in with ChatGPT",
      "Use your ChatGPT plan for eligible Responses API requests",
      0,
      "oauth",
    ],
    [
      "oauth",
      "openai",
      "Codex login",
      "Sign in with your ChatGPT account using a one-time code",
      -10,
      "device-code",
    ],
  ] as const;
  const otherProviders = [
    ["zeta", "Zeta"],
    ["anthropic", "Anthropic"],
    ["google", "Google"],
    ["xai", "xAI"],
    ["openrouter", "OpenRouter"],
    ["alpha", "Alpha"],
  ] as const;
  vi.mocked(resolveManifestDeclaredProviderAuthChoices).mockReturnValueOnce([
    ...otherProviders.map(([id, label]) => ({
      pluginId: id,
      providerId: id,
      methodId: "api-key",
      choiceId: `${id}-key`,
      choiceLabel: `${label} API key`,
      groupId: id,
      groupLabel: label,
      appGuidedSecret: true as const,
    })),
    ...openaiChoices.map(
      ([methodId, choiceId, choiceLabel, choiceHint, assistantPriority, appGuidedAuth]) => ({
        pluginId: "openai",
        providerId: "openai",
        methodId,
        choiceId,
        choiceLabel,
        choiceHint,
        assistantPriority,
        groupId: "openai",
        groupLabel: "OpenAI",
        appGuidedAuth,
        appGuidedSecret: appGuidedAuth ? undefined : (true as const),
        credentialOnly: appGuidedAuth ? (true as const) : undefined,
      }),
    ),
  ]);
  prompts.select.mockResolvedValueOnce("openai/openai-token-sharing");

  await expect(readGatewayLoginParams({}, "login", new AbortController().signal)).resolves.toEqual({
    sessionId: "login",
    authChoice: "openai/openai-token-sharing",
    agentId: undefined,
  });
  const selection = prompts.select.mock.calls[0]?.[0];
  expect(selection).toMatchObject({
    message: "Choose a provider sign-in method",
    searchable: true,
  });
  expect(selection?.options.map((option: { value: string }) => option.value)).toEqual([
    "openai/openai",
    "openai/openai-token-sharing",
    "openai/openai-api-key",
    "openrouter/openrouter-key",
    "xai/xai-key",
    "google/google-key",
    "anthropic/anthropic-key",
    "alpha/alpha-key",
    "zeta/zeta-key",
  ]);
  expect(selection?.options.slice(0, 3)).toEqual([
    {
      value: "openai/openai",
      label: "OpenAI · Codex login",
      hint: "Sign in with your ChatGPT account using a one-time code · openai / oauth",
    },
    {
      value: "openai/openai-token-sharing",
      label: "OpenAI · Sign in with ChatGPT",
      hint: "Use your ChatGPT plan for eligible Responses API requests · openai / siwc",
    },
    {
      value: "openai/openai-api-key",
      label: "OpenAI API Key",
      hint: "Use your OpenAI API key directly · openai / api-key",
    },
  ]);
});

it("selects an explicit provider and method from multiple eligible choices without prompting", async () => {
  vi.mocked(resolveManifestDeclaredProviderAuthChoices).mockReturnValueOnce(
    [
      { pluginId: "other", providerId: "other", methodId: "oauth", choiceId: "other-oauth" },
      { pluginId: "xai", providerId: "xai", methodId: "api-key", choiceId: "xai-api-key" },
      { pluginId: "xai", providerId: "xai", methodId: "oauth", choiceId: "xai-oauth" },
    ].map(({ pluginId, providerId, methodId, choiceId }) => ({
      pluginId,
      providerId,
      methodId,
      choiceId,
      choiceLabel: choiceId,
      appGuidedAuth: "oauth" as const,
      credentialOnly: true,
    })),
  );

  await expect(
    readGatewayLoginParams(
      { provider: "xai", method: "oauth", agent: "main" },
      "login",
      new AbortController().signal,
    ),
  ).resolves.toEqual({ sessionId: "login", authChoice: "xai/xai-oauth", agentId: "main" });
  expect(prompts.select).not.toHaveBeenCalled();
});

it("exits without starting a login when the provider chooser is cancelled", async () => {
  const choices = Array.from({ length: 2 }, (_, index) => ({
    pluginId: `provider-${index}`,
    providerId: `provider-${index}`,
    methodId: "api-key",
    choiceId: "api-key",
    choiceLabel: `Provider ${index}`,
    appGuidedSecret: true as const,
  }));
  vi.mocked(resolveManifestDeclaredProviderAuthChoices).mockReturnValueOnce(choices);
  prompts.select.mockRejectedValueOnce(new WizardCancelledError());
  await expect(readGatewayLoginParams({}, "login", new AbortController().signal)).rejects.toEqual(
    new ExitError(0),
  );
});

it("routes --device-code to the declared device-code sign-in under another method id", async () => {
  await expect(
    readGatewayLoginParams(
      { provider: "openai", method: "device-code" },
      "login",
      new AbortController().signal,
    ),
  ).resolves.toEqual({ sessionId: "login", authChoice: "openai/openai", agentId: undefined });
});

it("renders device codes and sends selection answers on the admitted session", async () => {
  prompts.select.mockResolvedValueOnce("keep");
  const h = gateway([
    step({
      id: "device",
      type: "note",
      message: "Approve sign-in",
      externalUrl: "https://github.com/login/device",
      deviceCode: { code: "ABCD-1234" },
    }),
    step({ id: "access", type: "select", options: [{ label: "Keep", value: "keep" }] }),
    done,
  ]);
  await h.run();
  expect(prompts.note).toHaveBeenCalledWith(
    "https://github.com/login/device",
    "Open this URL to continue",
  );
  expect(prompts.note).toHaveBeenCalledWith("ABCD-1234", "Device code");
  expect(h.calls).toEqual([next(), next("device"), next("access", "keep")]);
});

it("keeps the line breaks of multi-line login steps while stripping terminal controls", async () => {
  const message =
    "Enter this code.\nCode: ABCD-1234\n\n\u001b[31mxAI OAuth complete\u001b[0m\u0007";
  await gateway([
    step({ id: "device", type: "progress", title: "xAI OAuth", message }),
    done,
  ]).run();
  expect(prompts.note).toHaveBeenCalledWith(
    "Enter this code.\nCode: ABCD-1234\n\nxAI OAuth complete",
    "xAI OAuth",
  );
});

it("closes the admitted session when a terminal prompt is cancelled", async () => {
  prompts.select.mockRejectedValueOnce(new WizardCancelledError());
  const h = gateway([step({ id: "choice", type: "select", options: [] })]);
  await h.run();
  expect(h.calls.at(-1)).toEqual({
    method: "wizard.cancel",
    params: { sessionId: "login", closeInput: true },
  });
  expect(runtime.log).toHaveBeenCalledWith(
    "Login session closed. Credentials already saved were not undone.",
  );
});

it("observes browser completion while manual input remains open and retires the prompt", async () => {
  vi.useFakeTimers();
  let promptSignal: AbortSignal | undefined;
  prompts.text.mockImplementationOnce((_options, signal: AbortSignal) => {
    promptSignal = signal;
    const { promise, reject } = Promise.withResolvers<string>();
    signal.addEventListener("abort", () => reject(new WizardCancelledError()), { once: true });
    return promise;
  });
  const h = gateway([browserStep, done]);
  const finished = h.run();
  await vi.advanceTimersByTimeAsync(1_000);
  await finished;
  expect(promptSignal?.aborted).toBe(true);
  expect(h.calls).toEqual([next(), next()]);
  expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("confirmed"));
});

it("reconciles a browser callback that completes before the manual answer arrives", async () => {
  prompts.text.mockResolvedValueOnce("authorization-code");
  const h = gateway([browserStep, new Error("wizard not running"), done]);
  await h.run();
  expect(h.calls).toEqual([next(), next("code", "authorization-code"), next()]);
});

it("acknowledges a published auth update", async () => {
  gatewayMocks.callGateway.mockResolvedValueOnce({ refreshed: true });
  await expectRefresh("refreshed", undefined, "update");
  expect(gatewayMocks.callGateway).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "models.authRefresh",
      params: { operation: "update", agentId: "main" },
      requireLocalBackendSharedAuth: true,
    }),
  );
});

it("keeps restart guidance when legacy status refresh fails", async () => {
  const error = new GatewayClientRequestError({
    code: "INVALID_REQUEST",
    message: "unknown method: models.authRefresh",
  });
  gatewayMocks.callGateway.mockImplementation(
    async (options: { method: string; onHelloOk?: () => void }) => {
      options.onHelloOk?.();
      if (options.method === "models.authRefresh") {
        throw error;
      }
      throw new Error("legacy refresh failed");
    },
  );
  await expectRefresh(
    "gateway-rejected",
    "Warning: Model auth changes were saved, but the running Gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.",
  );
  expect(gatewayMocks.callGateway).toHaveBeenCalledTimes(2);
  expect(gatewayMocks.callGateway).toHaveBeenLastCalledWith(
    expect.objectContaining({
      method: "models.authStatus",
      params: { refresh: true, agentId: "main" },
      timeoutMs: 3000,
      requireLocalBackendSharedAuth: true,
    }),
  );
});

it("stays silent when no gateway is listening", async () => {
  gatewayMocks.callGateway.mockRejectedValueOnce(
    new GatewayTransportError({
      kind: "closed",
      message: "gateway unreachable",
      reason: "connect ECONNREFUSED 127.0.0.1:18789",
      connectionDetails: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
        message: "Local target",
      },
    }),
  );
  await expectRefresh("gateway-unreachable");
  expect(gatewayMocks.callGateway).toHaveBeenCalledWith(
    expect.objectContaining({ requireLocalBackendSharedAuth: true }),
  );
});

it("directs remote clients to run auth changes on the gateway host", async () => {
  gatewayMocks.isImplicitLocalGatewayTarget.mockResolvedValueOnce(false);
  gatewayMocks.callGateway.mockRejectedValueOnce(
    new GatewayLocalBackendSharedAuthUnavailableError(
      "local backend shared auth is limited to the configured local gateway",
    ),
  );
  await expectRefresh(
    "gateway-rejected",
    "Warning: Model auth changes were saved on this host, but the configured Gateway does not share this auth state. Run the auth command on the Gateway host (the far end of any SSH tunnel).",
  );
});

it("does not guess a restart host when target classification fails", async () => {
  gatewayMocks.isImplicitLocalGatewayTarget.mockRejectedValueOnce(new Error("invalid config"));
  await expectRefresh(
    "gateway-unreachable",
    "Warning: Model auth changes were saved, but the configured Gateway could not be identified or refreshed. Apply the auth change on the Gateway host, or restart it there.",
  );
  expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
});
