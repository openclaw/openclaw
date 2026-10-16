import { afterEach, expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestFunction } from "../../gateway/call.js";
import { resolveManifestDeclaredProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { readGatewayLoginParams, runGatewayLoginWizard } from "./auth-login-gateway.js";

const prompts = vi.hoisted(() => ({
  note: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  multiselect: vi.fn(),
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
  ]),
}));
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv;
function gateway(results: Array<WizardNextResult | Error>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request: GatewayRequestFunction = async <T>(
    method: string,
    params?: unknown,
  ): Promise<T> => {
    calls.push({ method, params });
    const result = method === "wizard.cancel" ? { status: "cancelled" } : results.shift();
    if (!result) {
      throw new Error("Unexpected wizard request");
    }
    if (result instanceof Error) {
      throw result;
    }
    return result as T;
  };
  return { request, calls };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("maps normalized API-key method and agent to the exact plugin choice", async () => {
  await expect(
    readGatewayLoginParams(
      { provider: "OpenAI", method: "API-KEY", agent: "writer" },
      "login",
      new AbortController().signal,
    ),
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
    ["api-key", "openai-api-key", "OpenAI API Key", "Platform API billing", 5],
    ["siwc", "openai-token-sharing", "Sign in with ChatGPT (Beta)", "App-specific grant", 0],
    ["oauth", "openai", "Codex login (browser)", "ChatGPT browser sign-in", -10],
    ["device-code", "openai-device-code", "Codex login (device code)", "Remote device code", -40],
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
    ...openaiChoices.map(([methodId, choiceId, choiceLabel, choiceHint, assistantPriority]) => ({
      pluginId: "openai",
      providerId: "openai",
      methodId,
      choiceId,
      choiceLabel,
      choiceHint,
      assistantPriority,
      groupId: "openai",
      groupLabel: "OpenAI",
      appGuidedAuth: "oauth" as const,
      credentialOnly: true,
    })),
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
    "openai/openai-device-code",
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
  expect(selection?.options.slice(0, 4)).toEqual([
    {
      value: "openai/openai-device-code",
      label: "OpenAI · Codex login (device code)",
      hint: "Remote device code · openai / device-code",
    },
    {
      value: "openai/openai",
      label: "OpenAI · Codex login (browser)",
      hint: "ChatGPT browser sign-in · openai / oauth",
    },
    {
      value: "openai/openai-token-sharing",
      label: "OpenAI · Sign in with ChatGPT (Beta)",
      hint: "App-specific grant · openai / siwc",
    },
    {
      value: "openai/openai-api-key",
      label: "OpenAI API Key",
      hint: "Platform API billing · openai / api-key",
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

it("renders device codes and sends selection answers on the admitted session", async () => {
  prompts.select.mockResolvedValueOnce("keep");
  const h = gateway([
    {
      done: false,
      step: {
        id: "device",
        type: "note",
        message: "Approve sign-in",
        externalUrl: "https://github.com/login/device",
        deviceCode: { code: "ABCD-1234" },
      },
    },
    {
      done: false,
      step: { id: "access", type: "select", options: [{ label: "Keep", value: "keep" }] },
    },
    { done: true, status: "done" },
  ]);
  await runGatewayLoginWizard(h.request, "login", new AbortController().signal, runtime);
  expect(prompts.note).toHaveBeenCalledWith(
    "https://github.com/login/device",
    "Open this URL to continue",
  );
  expect(prompts.note).toHaveBeenCalledWith("ABCD-1234", "Device code");
  expect(h.calls).toEqual([
    { method: "wizard.next", params: { sessionId: "login" } },
    {
      method: "wizard.next",
      params: { sessionId: "login", answer: { stepId: "device", value: undefined } },
    },
    {
      method: "wizard.next",
      params: { sessionId: "login", answer: { stepId: "access", value: "keep" } },
    },
  ]);
});

it("closes the admitted session when a terminal prompt is cancelled", async () => {
  prompts.select.mockRejectedValueOnce(new WizardCancelledError());
  const h = gateway([{ done: false, step: { id: "choice", type: "select", options: [] } }]);
  await runGatewayLoginWizard(h.request, "login", new AbortController().signal, runtime);
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
  const h = gateway([
    {
      done: false,
      step: { id: "code", type: "text", externalUrl: "https://example.test/authorize" },
    },
    { done: true, status: "done" },
  ]);
  const finished = runGatewayLoginWizard(h.request, "login", new AbortController().signal, runtime);
  await vi.advanceTimersByTimeAsync(1_000);
  await finished;
  expect(promptSignal?.aborted).toBe(true);
  expect(h.calls).toEqual([
    { method: "wizard.next", params: { sessionId: "login" } },
    { method: "wizard.next", params: { sessionId: "login" } },
  ]);
  expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("confirmed"));
});

it("reconciles a browser callback that completes before the manual answer arrives", async () => {
  prompts.text.mockResolvedValueOnce("authorization-code");
  const h = gateway([
    {
      done: false,
      step: { id: "code", type: "text", externalUrl: "https://example.test/authorize" },
    },
    new Error("wizard not running"),
    { done: true, status: "done" },
  ]);
  await runGatewayLoginWizard(h.request, "login", new AbortController().signal, runtime);
  expect(h.calls).toEqual([
    { method: "wizard.next", params: { sessionId: "login" } },
    {
      method: "wizard.next",
      params: { sessionId: "login", answer: { stepId: "code", value: "authorization-code" } },
    },
    { method: "wizard.next", params: { sessionId: "login" } },
  ]);
});
