/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, SystemAgentSetupDetectResult } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
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
// The Gateway always sends its bundled install catalog (scripts/lib/recommended-tool-installs.json).
const ollamaInstall = {
  id: "ollama",
  brandId: "ollama",
  label: "Ollama",
  hint: "Run open models locally",
  website: "https://ollama.com/download",
  icon: "https://cdn.simpleicons.org/ollama",
};
function detection(candidates: Detection["candidates"] = [codex, local]): Detection {
  return {
    candidates,
    manualProviders: [apiKey],
    authOptions: [chatgpt],
    prepareOptions: [lmStudio],
    recommendedInstalls: [ollamaInstall],
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
        : method === "openclaw.setup.options"
          ? new Promise(() => {})
          : (handlers[method]?.(params) ?? reply),
  );
}
const setupContext = (request: Request) => createContext(request, methods, { agentsList });
async function mountSetup(request: Request) {
  const harness = setupContext(request);
  const mounted = await mountPage(harness.context);
  await settled(mounted.page);
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
/** A picker row's title, without its badge and subtitle. */
const rowTitle = (row: Element) => row.querySelector("strong")?.firstChild?.textContent;
const rowTitles = (page: Page) =>
  [...page.querySelectorAll(".custodian-setup__list .option-card__choice")].map(rowTitle);
function findButton(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll("button")].find(
    (entry) =>
      entry.textContent?.trim() === label ||
      (entry.classList.contains("option-card__choice") && rowTitle(entry) === label),
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
  // The Mac's rows, ChatGPT first, never a model id.
  expect(rowTitles(page)).toEqual(["ChatGPT", "API key", "A model on your own computer"]);
  text(page).not.toContain("Codex");
  text(page).not.toContain("Sign in with ChatGPT");
  text(page).not.toContain("openai/gpt-5.5");
  await click(page, "A model on your own computer");
  const row = findButton(page, "Local modelLoaded in OllamaUse");
  row.click();
  row.click();
  await waitForFast(() =>
    text(page).toContain("Checking a real conversation. This may take a minute."),
  );
  expect(calls(request, "activate.start")).toHaveLength(1);
  expectRpc(
    request,
    "activate.start",
    expect.objectContaining({ kind: local.kind, modelRef: local.modelRef }),
  );
  activation.resolve(activated("ollama/qwen3"));
  await settled(page, () => page.store.autoSetup.ready);
  text(page).toContain("You’re all set!");
  text(page).toContain("Using Local model (ollama/qwen3) on gateway.test");
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
  await click(page, "ChatGPT");
  await waitForFast(() =>
    text(page).toContain("It couldn’t complete the test. Try again, or choose another AI."),
  );
  const details = page.querySelector<HTMLDetailsElement>(".custodian-setup details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("pre")?.textContent).toBe(error);
  expect(page.store.autoSetup.ready).toBe(false);
  // The existing Codex login is tested in place, as automatic setup does.
  expectRpc(
    request,
    "activate.start",
    expect.objectContaining({ kind: "codex-cli", shareCodexLogin: true }),
  );
  // After the stored login fails its test, ChatGPT offers its one sign-in, as on main.
  findButton(page, "Sign in with ChatGPT").click();
  await waitForFast(() =>
    expectRpc(request, "auth.start", expect.objectContaining({ authChoice: chatgpt.id })),
  );
});

it("names the shared Codex login on the finished card and signs in separately", async () => {
  const request = setupRequest(undefined, {
    "openclaw.setup.activate.start": () => activated("openai/gpt-5.5"),
    "openclaw.setup.auth.start": () => new Promise(() => {}),
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "ChatGPT", () => page.store.autoSetup.ready);
  text(page).toContain("Using ChatGPT (openai/gpt-5.5) on gateway.test");
  text(page).toContain("Using your existing Codex login · sessions shared with Codex");
  findButton(page, "Sign in separately").click();
  await waitForFast(() =>
    expectRpc(request, "auth.start", expect.objectContaining({ authChoice: chatgpt.id })),
  );
});

it("changes where the assistant runs on the connection page in a browser", async () => {
  const { page, context } = await mountSetup(setupRequest());
  await click(page, "Next");
  await click(page, "On this computer");
  expect(context.navigate).toHaveBeenCalledWith("connection");
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
  // With no Codex login, picking ChatGPT starts its sign-in, as on the Mac.
  await click(page, "ChatGPT");
  expectRpc(request, "auth.start", expect.objectContaining({ authChoice: chatgpt.id }));
  await click(page, "Yes");
  if (outcome === "done") {
    text(page).toContain("You’re all set!");
    return;
  }
  const alert = page.querySelector<HTMLElement>('.custodian-setup [role="alert"]')!;
  expect(alert.querySelector("strong")?.textContent).toBe("Sign-in didn’t complete");
  expect(alert.querySelector("p")?.textContent).toBe("Try again, or choose another AI.");
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
  await click(page, "Try again");
  expect(calls(request, "detect")).toHaveLength(2);
  findButton(page, "ChatGPT");
});

it("restores shared Codex setup when opening a configured Gateway", async () => {
  const configuredModel = "openai/gpt-5.5";
  const notice = "Using your existing Codex login · sessions shared with Codex";
  const request = setupRequest(
    () => ({
      ...detection([]),
      configuredModel,
      configuredModelSharedCodexLogin: true,
      setupComplete: true,
    }),
    { "openclaw.setup.auth.start": () => activated(configuredModel) },
  );
  const { page } = await mountSetup(request);
  text(page).toContain(notice);
  text(page).toContain(reply.reply);
  expect([...calls(request, "auto"), ...calls(request, "activate.start")]).toHaveLength(0);

  await click(page, "Sign in separately", () => page.store.autoSetup.connection !== null);
  expectRpc(request, "auth.start", expect.objectContaining({ authChoice: chatgpt.id }));
  text(page).not.toContain(notice);
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
  text(page).toContain("On this computer RecommendedStudio Mac");
  // The other place is another Gateway, chosen in the shell's Gateways window.
  await click(page, "On another computer");
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
  findButton(page, "ChatGPT").click();
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
  const lmStudioModel: Detection["candidates"][number] = {
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
  await click(page, "A model on your own computer");
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

it("offers each local app download until the Gateway finds a model from that app", async () => {
  const ollama = {
    id: "ollama",
    brandId: "ollama",
    label: "Ollama",
    actionLabel: "Choose connection",
  };
  const lmStudioInstall = {
    id: "lmstudio",
    brandId: "lmstudio",
    label: "LM Studio",
    hint: "Local model desktop app",
    website: "https://lmstudio.ai/download",
    icon: "https://cdn.simpleicons.org/lmstudio",
  };
  let candidates: Detection["candidates"] = [];
  const request = setupRequest(() => ({
    ...detection(candidates),
    prepareOptions: [ollama, lmStudio],
    recommendedInstalls: [ollamaInstall, lmStudioInstall],
  }));
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "A model on your own computer");
  const downloads = () =>
    [...page.querySelectorAll<HTMLAnchorElement>(".custodian-setup a[href]")].map(
      (link) => link.href,
    );
  expect(downloads()).toEqual([ollamaInstall.website, lmStudioInstall.website]);

  candidates = [local];
  await click(page, "Check again");
  expect(downloads()).toEqual([lmStudioInstall.website]);
});

it("activates the prepared Ollama model when discovery omits it", async () => {
  const modelRef = "ollama/qwen3:0.6b";
  const request = setupRequest(
    () => ({
      ...detection([codex]),
      prepareOptions: [
        { id: "ollama", brandId: "ollama", label: "Ollama", actionLabel: "Choose connection" },
      ],
    }),
    {
      "openclaw.setup.prepare.start": () => ({
        done: true,
        status: "done",
        preparedModelRef: modelRef,
      }),
      "openclaw.setup.activate.start": () => activated(modelRef),
    },
  );
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "A model on your own computer");
  await click(page, "OllamaChoose connection");
  await waitForFast(() =>
    expectRpc(
      request,
      "activate.start",
      expect.objectContaining({ kind: "provider-auto:ollama", modelRef }),
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
  await click(page, "API key");
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

it("uses a Claude Code login the Gateway found with one click", async () => {
  const claudeCode = {
    kind: "claude-cli",
    brandId: "anthropic",
    label: "Claude Code",
    detail: "installed; signed in",
    modelRef: "anthropic/claude-sonnet",
    recommended: false,
  } satisfies Detection["candidates"][number];
  const request = setupRequest(() => detection([claudeCode]), {
    "openclaw.setup.activate.start": () => activated(claudeCode.modelRef),
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "Claude");
  expectRpc(request, "activate.start", expect.objectContaining({ kind: "claude-cli" }));
  await settled(page, () => page.store.autoSetup.ready);
  text(page).toContain("You’re all set!");
});

it("recovers from a failed Claude Code login using an API key", async () => {
  const modelRef = "anthropic/claude-sonnet";
  const claudeCode = {
    kind: "claude-cli",
    brandId: "anthropic",
    label: "Claude Code",
    detail: "installed; login status unverified",
    modelRef,
    recommended: false,
  } satisfies Detection["candidates"][number];
  const request = setupRequest(
    () => ({
      ...detection([claudeCode]),
      manualProviders: [
        { ...apiKey, id: "anthropic-api-key", brandId: "anthropic", groupLabel: "Anthropic" },
      ],
    }),
    {
      "openclaw.setup.activate.start": vi
        .fn()
        .mockReturnValueOnce(failed("Claude Code is signed out"))
        .mockReturnValueOnce(activated(modelRef)),
    },
  );
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "Claude");
  expectRpc(request, "activate.start", expect.objectContaining({ kind: "claude-cli" }));
  expect(page.querySelector(".custodian-setup details pre")?.textContent).toBe(
    "Claude Code is signed out",
  );
  await click(page, "Choose another AI");
  await click(page, "API key");
  const key = page.querySelector<HTMLInputElement>('.custodian-setup input[name="key"]');
  expect(key).not.toBeNull();
  key!.value = "sk-test-claude-recovery";
  key!.form!.requestSubmit();
  await settled(page, () => page.store.autoSetup.ready);
  expectRpc(
    request,
    "activate.start",
    expect.objectContaining({
      kind: "api-key",
      authChoice: "anthropic-api-key",
      apiKey: "sk-test-claude-recovery",
    }),
  );
  text(page).toContain("You’re all set!");
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
  await click(page, "ChatGPT");
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

it("keeps provider preparation visible after cancellation is declined", async () => {
  const answer = createDeferred<unknown>();
  const cancel = vi
    .fn()
    .mockReturnValueOnce({ status: "running" })
    .mockReturnValue({ status: "cancelled" });
  const request = setupRequest(() => detection([codex]), {
    "openclaw.setup.prepare.start": () => ({ done: false, status: "running" }),
    "wizard.next": (params) =>
      params?.answer
        ? answer.promise
        : {
            done: false,
            step: { id: "connect", type: "confirm", message: "Connect to LM Studio?" },
          },
    "wizard.cancel": cancel,
  });
  const { page } = await mountSetup(request);
  await openAiStep(page);
  await click(page, "A model on your own computer");
  await click(page, "LM StudioConnect server");
  findButton(page, "Yes").click();
  await waitForSolid(() => expect(findButton(page, "Yes").disabled).toBe(true));
  findButton(page, "Choose another AI").click();
  await waitForFast(() => expect(cancel).toHaveBeenCalledOnce());
  answer.resolve({
    done: false,
    step: { id: "confirm-model", type: "confirm", message: "Use the loaded model?" },
  });
  await settled(page);
  text(page).toContain("Use the loaded model?");
  expect(findButton(page, "Yes").disabled).toBe(false);

  await waitForSolid(() => expect(findButton(page, "Choose another AI").disabled).toBe(false));
  findButton(page, "Choose another AI").click();
  await waitForSolid(() => expect(findButton(page, "ChatGPT").disabled).toBe(false));
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
