/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, SystemAgentSetupDetectResult } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
// The surface lazy-loads the card; load it up front so the first test does not wait on a cold import.
import "./custodian-setup-card.tsx";
import { CustodianSessionStore } from "./custodian-session-store.ts";

type Detection = SystemAgentSetupDetectResult;
const codex = {
  kind: "codex-cli",
  brandId: "openai",
  label: "Codex",
  // What Gateway detection reports for a Codex login it found on disk.
  detail: "installed; stored credentials found; login status unverified",
  modelRef: "openai/gpt-5.5",
  recommended: true,
  credentials: true,
} satisfies Detection["candidates"][number];
const local = {
  kind: "provider-auto:ollama",
  brandId: "ollama",
  label: "Local model",
  detail: "Loaded in Ollama",
  modelRef: "ollama/qwen3",
  recommended: false,
} satisfies Detection["candidates"][number];
const chatgpt = {
  id: "openai-token-sharing",
  brandId: "openai",
  label: "Sign in with ChatGPT",
  kind: "oauth",
  featured: false,
} satisfies NonNullable<Detection["authOptions"]>[number];
const apiKey = { id: "openai-api-key", brandId: "openai", groupLabel: "OpenAI", label: "API key" };
const lmStudio = {
  id: "lmstudio",
  brandId: "lmstudio",
  label: "LM Studio",
  actionLabel: "Connect server",
};
function detection(candidates: Detection["candidates"] = [codex, local]): Detection {
  return {
    candidates,
    manualProviders: [apiKey],
    authOptions: [chatgpt],
    prepareOptions: [lmStudio],
    workspace: "/workspace",
    setupComplete: false,
  };
}
/** Activation runs as a wizard; a finished one reports the model it saved. */
const activated = (modelRef: string) => ({
  done: true,
  status: "done",
  modelActivation: { modelRef },
});
const failed = (error: string) => ({ done: true, status: "error", error });
const methods = [
  "chat",
  "setup.detect",
  "setup.activate.start",
  "setup.auth.start",
  "setup.prepare.start",
].map((method) => "openclaw." + method);
const agentsList: AgentsListResult = makeBootRoster({ scope: "global" });
const reply = { sessionId: "setup-session", reply: "Welcome.", action: "none" };
type Page = Awaited<ReturnType<typeof mountPage>>["page"];
type Request = Parameters<typeof createContext>[0];
const text = (page: Page) => expect(page.textContent);
const expectRpc = (request: Request, method: string, params: unknown) =>
  expect(request).toHaveBeenCalledWith("openclaw.setup." + method, params, { timeoutMs: null });
function setupRequest(
  detect: () => unknown = () => detection(),
  handlers: Record<string, (params?: { answer?: unknown }) => unknown> = {},
) {
  return vi.fn(async (method: string, params?: { answer?: unknown }) =>
    method === "openclaw.chat.history"
      ? (handlers[method]?.(params) ?? { turns: [] })
      : method === "openclaw.setup.detect"
        ? detect()
        : (handlers[method]?.(params) ?? reply),
  );
}
const setupContext = (request: Request) => createContext(request, methods, { agentsList });
async function mountSetup(request: Request) {
  const harness = setupContext(request);
  const mounted = await mountPage(harness.context);
  await settled(mounted.page);
  // The card is lazy-loaded so it stays out of the chat boot bundle.
  await waitForSolid(() => expect(mounted.page.querySelector(".custodian-setup")).not.toBeNull());
  return { ...harness, ...mounted };
}
async function settled(page: Page, expected = () => true) {
  await new Promise<void>((resolve) => {
    const ready = () => {
      const setup = page.store.autoSetup;
      if (
        expected() &&
        !setup.pending &&
        !page.store.sending &&
        setup.wizard.state.phase !== "starting" &&
        !(setup.wizard.state.phase === "step" && setup.wizard.state.busy)
      ) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = page.store.subscribe(ready);
    ready();
  });
  flush();
  await page.updateComplete;
}
function findButton(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  return button!;
}
async function click(page: Page, label: string, expected?: () => boolean) {
  findButton(page, label).click();
  await settled(page, expected);
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  delete window["__OPENCLAW_NATIVE_SETUP__"];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openAiStep(page: Page) {
  text(page).toContain("Welcome to OpenClaw");
  await click(page, "Next");
  text(page).toContain("Where should your assistant run?");
  text(page).toContain("On another computer");
  text(page).toContain("gateway.test");
  await click(page, "Next");
  text(page).toContain("Connect your AI");
}
const calls = (request: Request, method: string) =>
  request.mock.calls.filter(([name]) => name === "openclaw.setup." + method);

it("waits for the user to pick the detected AI before testing and saving it", async () => {
  const activation = createDeferred<unknown>();
  const request = setupRequest(undefined, {
    "openclaw.setup.activate.start": () => activation.promise,
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  expectRpc(request, "detect", {});
  expect(calls(request, "activate.start")).toHaveLength(0);
  expect(request.mock.calls.filter(([method]) => method === "openclaw.chat")).toHaveLength(0);
  // Rows name the AI the way the Mac does, never by model id.
  // A Codex login and the ChatGPT sign-in are one ChatGPT choice.
  text(page).toContain("ChatGPTUse your existing login");
  // ChatGPT, Local model, LM Studio, API Keys.
  expect(page.querySelectorAll(".custodian-setup .option-card__choice").length).toBe(4);
  text(page).not.toContain("Codex");
  text(page).not.toContain("Sign in with ChatGPT");
  text(page).not.toContain("openai/gpt-5.5");
  const row = findButton(page, "Local modelLoaded in Ollama");
  row.click();
  row.click();
  await waitForFast(() => text(page).toContain("Asking for a quick reply…"));
  expect(calls(request, "activate.start")).toHaveLength(1);
  expectRpc(
    request,
    "activate.start",
    expect.objectContaining({ kind: local.kind, modelRef: local.modelRef }),
  );
  activation.resolve(activated("ollama/qwen3"));
  await settled(page, () => page.store.autoSetup.ready);
  text(page).toContain("You’re all set!");
  text(page).not.toContain("ollama/qwen3");
  await waitForFast(() => text(page).toContain(reply.reply));
});

it("shows a short reason for a failed test and folds the Gateway's error into details", async () => {
  const error =
    "OAuth token refresh failed for openai: Auth profile credential authority is unavailable";
  const request = setupRequest(undefined, {
    "openclaw.setup.activate.start": () => failed(error),
    "openclaw.setup.auth.start": () => new Promise(() => {}),
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "ChatGPTUse your existing login");
  const row = findButton(
    page,
    "ChatGPTIt couldn’t complete the test. Try again, or choose another AI.Sign in",
  );
  const details = page.querySelector<HTMLDetailsElement>(".custodian-setup details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("pre")?.textContent).toBe(error);
  expect(page.store.autoSetup.ready).toBe(false);
  // The same row now signs in instead of retrying the login that failed.
  row.click();
  await waitForFast(() =>
    expectRpc(request, "auth.start", expect.objectContaining({ authChoice: chatgpt.id })),
  );
});

// Real error text from a failed first-run ChatGPT sign-in (Control UI, 2026-11-19).
const realSignInError =
  "Credentials saved; default unchanged. OAuth token refresh failed for openai: Auth profile credential authority is unavailable; retry after owner recovery. Please try again or re-authenticate. Choose the saved sign-in in Model Setup to retry without signing in again.";

it.each([
  ["done", { done: true, status: "done", modelActivation: { modelRef: "openai/gpt-5.5" } }],
  ["error", { done: true, status: "error", error: realSignInError }],
] as const)("signs in with ChatGPT from the AI step (%s)", async (outcome, finish) => {
  const request = setupRequest(() => detection([]), {
    "openclaw.setup.auth.start": () => ({ sessionId: "auth-session", done: false }),
    "wizard.next": (params) =>
      params?.answer
        ? finish
        : { done: false, step: { id: "confirm", type: "confirm", message: "Finish signing in?" } },
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  text(page).toContain("No usable AI access found on this Gateway");
  await click(page, "ChatGPTSign in");
  expectRpc(request, "auth.start", expect.objectContaining({ authChoice: chatgpt.id }));
  await click(page, "Yes");
  if (outcome === "done") {
    text(page).toContain("You’re all set!");
    return;
  }
  const alert = page.querySelector<HTMLElement>('.custodian-setup [role="alert"]')!;
  expect(alert.querySelector("strong")?.textContent).toBe("ChatGPT didn’t finish");
  expect(alert.querySelector("p")?.textContent).toBe(
    "Sign-in didn’t work. Try again, or choose another AI.",
  );
  expect(alert.querySelector("details")?.open).toBe(false);
  expect(alert.querySelector("pre")?.textContent).toContain(realSignInError);
});

it("shows detection failures briefly and checks again", async () => {
  let attempts = 0;
  const request = setupRequest(() => {
    if (attempts++ === 0) {
      throw new Error("Gateway lost its connection");
    }
    return detection();
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  const alert = page.querySelector('[role="alert"]')!;
  expect(alert.querySelector("strong")?.textContent).toBe(
    "Couldn’t check this Gateway for AI access",
  );
  expect(alert.querySelector("pre")?.textContent).toContain("Gateway lost its connection");
  await click(page, "Retry");
  expect(calls(request, "detect")).toHaveLength(2);
  text(page).toContain("ChatGPTUse your existing login");
});

it("shows a configured Gateway as done without testing anything", async () => {
  const request = setupRequest();
  const configured = makeBootRoster({
    agents: [{ id: "main", model: { primary: "openai/gpt-5.5" } }],
  });
  const { context } = createContext(request, methods, { agentsList: configured });
  const { page } = await mountPage(context);
  await settled(page);
  await waitForSolid(() => text(page).toContain("You’re all set!"));
  expect(calls(request, "activate")).toHaveLength(0);
  text(page).toContain(reply.reply);
});

it("uses shell-neutral native capabilities for Gateway selection and permissions", async () => {
  const openGateways = vi.fn();
  const reviewPermissions = vi.fn();
  window["__OPENCLAW_NATIVE_SETUP__"] = {
    currentGateway: { name: "Studio Mac", kind: "local" },
    openGateways,
    reviewPermissions,
  };
  const { page } = await mountSetup(setupRequest());
  await click(page, "Next");
  text(page).toContain("On this computerStudio Mac");
  await click(page, "Use a different Gateway");
  await click(page, "Review permissions");
  expect(openGateways).toHaveBeenCalledOnce();
  expect(reviewPermissions).toHaveBeenCalledOnce();
});

it("retires a held activation when the visible store is replaced", async () => {
  const activation = createDeferred<unknown>();
  const request = setupRequest(undefined, {
    "openclaw.setup.activate.start": () => activation.promise,
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  findButton(page, "ChatGPTUse your existing login").click();
  await waitForFast(() => expect(page.store.autoSetup.testing).toBe("codex-cli"));
  page.store = new CustodianSessionStore();
  await settled(page, () => page.store.autoSetup.detection !== null);
  text(page).toContain("Welcome to OpenClaw");
  activation.resolve(failed("Retired activation failed"));
  await activation.promise;
  await page.updateComplete;
  expect(page.store.autoSetup.attemptFailure).toBeNull();
  text(page).not.toContain("Retired activation failed");
});

it("sets up a local model from the card, as on the Mac", async () => {
  const lmStudioModel = {
    kind: "provider-auto:lmstudio",
    brandId: "lmstudio",
    label: "LM Studio",
    detail: "Model loaded",
    modelRef: "lmstudio/qwen3",
    recommended: false,
  };
  let prepared = false;
  const request = setupRequest(() => detection(prepared ? [lmStudioModel] : [codex]), {
    "openclaw.setup.activate.start": () => activated("lmstudio/qwen3"),
    "openclaw.setup.prepare.start": () => {
      prepared = true;
      return { done: true, status: "done", preparedModelRef: "lmstudio/qwen3" };
    },
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "LM StudioConnect server");
  expectRpc(request, "prepare.start", expect.objectContaining({ authChoice: lmStudio.id }));
  await waitForFast(() =>
    expectRpc(
      request,
      "activate.start",
      expect.objectContaining({ kind: "provider-auto:lmstudio", modelRef: "lmstudio/qwen3" }),
    ),
  );
  await settled(page, () => page.store.autoSetup.ready);
  text(page).toContain("You’re all set!");
});

it("connects an API key from the card's own form", async () => {
  const request = setupRequest(undefined, {
    "openclaw.setup.activate.start": () => activated("openai/gpt-5.5"),
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "API KeysConnect with an API key or tokenConnect");
  const form = page.querySelector("form")!;
  form.querySelector<HTMLInputElement>('input[name="key"]')!.value = "sk-test-not-real";
  form.requestSubmit();
  await waitForFast(() =>
    expectRpc(
      request,
      "activate.start",
      expect.objectContaining({
        kind: "api-key",
        authChoice: apiKey.id,
        apiKey: "sk-test-not-real",
      }),
    ),
  );
});

it("offers install links when the Gateway finds no AI", async () => {
  const ollama = {
    id: "ollama",
    label: "Ollama",
    hint: "Run open models locally",
    website: "https://ollama.com",
    icon: "https://ollama.com/icon.png",
  };
  const { page } = await mountSetup(
    setupRequest(() => ({ ...detection([]), recommendedInstalls: [ollama] })),
  );
  await openAiStep(page);
  text(page).toContain("Install one of these, then check again.");
  const link = page.querySelector<HTMLAnchorElement>('a[href="https://ollama.com"]')!;
  expect(link.textContent).toBe("OllamaRun open models locally");
  expect(link.target).toBe("_blank");
});

it("ignores an old Gateway result after connection ownership changes", async () => {
  const pending = createDeferred<Detection>();
  const request = vi.fn(async () => pending.promise);
  const { context, setGatewaySnapshot } = setupContext(request);
  const { page } = await mountPage(context);
  const replacement = setupRequest(() => detection([local]));
  setGatewaySnapshot({
    client: { request: replacement } as unknown as GatewayBrowserClient,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "synthetic-new-owner" },
      features: { methods },
    },
  });
  await settled(page);
  pending.resolve(detection());
  await pending.promise;
  await settled(page);
  expect(page.store.autoSetup.detection?.candidates).toEqual([local]);
});

it("keeps cancellation available during an answer and resumes after protected cancellation", async () => {
  const answer = createDeferred<unknown>();
  const cancellation = createDeferred<unknown>();
  const request = setupRequest(
    () => ({ ...detection([]), authOptions: [{ ...chatgpt, featured: true }] }),
    {
      "openclaw.setup.auth.start": () => ({ done: false }),
      "wizard.next": (params) =>
        params?.answer
          ? answer.promise
          : { done: false, step: { id: "confirm", type: "confirm", message: "Continue?" } },
      "wizard.cancel": () => cancellation.promise,
    },
  );
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "ChatGPTSign in");
  findButton(page, "Yes").click();
  await waitForSolid(() => expect(findButton(page, "Yes").disabled).toBe(true));
  expect(findButton(page, "Cancel").disabled).toBe(false);
  findButton(page, "Cancel").click();
  await waitForSolid(() => expect(findButton(page, "Cancel").disabled).toBe(true));
  cancellation.resolve({ status: "running" });
  await waitForSolid(() => expect(findButton(page, "Cancel").disabled).toBe(false));
  answer.resolve({
    done: false,
    step: { id: "confirm-again", type: "confirm", message: "Ready now?" },
  });
  await settled(page);
  text(page).toContain("Ready now?");
  expect(findButton(page, "Yes").disabled).toBe(false);
});

it("persists dismissal across a new custodian store", async () => {
  const request = setupRequest();
  const { context } = setupContext(request);
  const first = await mountPage(context);
  await settled(first.page);
  first.page.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click();
  await settled(first.page);
  expect(first.page.querySelector(".custodian-setup")).toBeNull();
  first.provider.remove();
  const second = await mountPage(context);
  await settled(second.page);
  expect(second.page.querySelector(".custodian-setup")).toBeNull();
});

it("preserves the existing caretaker flow without the advertised method", async () => {
  const request = vi.fn(async () => reply);
  const { context } = createContext(request, ["openclaw.chat"], { agentsList });
  const { page } = await mountPage(context, { onboarding: false });
  await settled(page);
  expect(page.querySelector(".custodian-setup")).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(page.querySelector(".custodian__setup-state")).not.toBeNull();
});
