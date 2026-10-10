import { afterEach, expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestFunction } from "../../gateway/call.js";
import type { RuntimeEnv } from "../../runtime.js";
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
  resolveManifestDeclaredProviderAuthChoices: () => [
    {
      pluginId: "openai",
      providerId: "openai",
      methodId: "api-key",
      choiceId: "openai-api-key",
      choiceLabel: "OpenAI API key",
      appGuidedSecret: true,
    },
  ],
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
    if (!result) throw new Error("Unexpected wizard request");
    if (result instanceof Error) throw result;
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
