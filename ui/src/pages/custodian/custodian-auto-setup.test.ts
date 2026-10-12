/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SetupAutoResult } from "./custodian-auto-setup.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

const selected = {
  kind: "codex",
  label: "ChatGPT",
  detail: "Saved sign-in",
  modelRef: "openai/gpt-5.5",
};
const alternative = {
  kind: "ollama",
  label: "Local model",
  detail: "Running locally",
  modelRef: "ollama/qwen3",
};
function result(status: SetupAutoResult["status"] = "activated"): SetupAutoResult {
  return { status, selected, alternatives: [alternative], attempts: [], installedPlugins: [] };
}
const methods = [
  "openclaw.chat",
  "openclaw.setup.auto",
  "openclaw.setup.activate",
  "openclaw.setup.auth.start",
];
const agentsList = {
  defaultId: "main",
  mainKey: "main",
  scope: "global",
  agents: [{ id: "main" }],
};
const reply = {
  sessionId: "setup-session",
  reply: "Welcome. What would you like to set up?",
  action: "none",
};
type Page = Awaited<ReturnType<typeof mountPage>>["page"];
async function settled(page: Page) {
  await page.updateComplete;
  await page.updateComplete;
}
function click(page: Page, text: string) {
  const button = [...page.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  button!.click();
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
});

describe("custodian automatic setup", () => {
  it.each(["configured", "activated"] as const)(
    "renders %s, selects an alternative, and greets only after setup",
    async (status) => {
      const setup = createDeferred<SetupAutoResult>();
      const request = vi.fn(async (method: string) => {
        if (method === "openclaw.setup.auto") {
          return setup.promise;
        }
        if (method === "openclaw.setup.activate") {
          return { ok: true, modelRef: alternative.modelRef };
        }
        return reply;
      });
      const { context } = createContext(request, methods, { agentsList });
      const { page } = await mountPage(context);
      expect(page.textContent).toContain("Connecting your AI");
      expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.auto"]);
      expect(request).toHaveBeenCalledWith("openclaw.setup.auto", {}, { timeoutMs: null });
      setup.resolve(result(status));
      await setup.promise;
      await settled(page);
      expect(page.textContent).toContain("Using ChatGPT (openai/gpt-5.5) on gateway.test");
      expect(page.textContent).toContain(reply.reply);
      click(page, "Local model");
      await settled(page);
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.activate",
        { kind: "ollama" },
        { timeoutMs: null },
      );
      expect(page.textContent).toContain("Using Local model (ollama/qwen3) on gateway.test");
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.auto"),
      ).toHaveLength(1);
    },
  );

  it("keeps the current selection and shows activation failure", async () => {
    const request = vi.fn(async (method: string) =>
      method === "openclaw.setup.auto"
        ? result()
        : method === "openclaw.setup.activate"
          ? { ok: false, error: "Local model is offline" }
          : reply,
    );
    const { context } = createContext(request, methods, { agentsList });
    const { page } = await mountPage(context);
    await settled(page);
    click(page, "Local model");
    await settled(page);
    expect(page.textContent).toContain("Using ChatGPT");
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Local model is offline");
  });

  it("uses the existing sign-in wizard and rechecks automatic setup after success", async () => {
    let autoCalls = 0;
    const request = vi.fn(async (method: string, params?: { answer?: unknown }) => {
      if (method === "openclaw.setup.auto") {
        return autoCalls++
          ? result()
          : {
              status: "needs-sign-in",
              alternatives: [],
              attempts: [],
              installedPlugins: ["codex"],
              signIn: { authOptionId: "codex-sign-in", label: "ChatGPT" },
            };
      }
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false };
      }
      if (method === "wizard.next") {
        return params?.answer
          ? { done: true, status: "done" }
          : {
              done: false,
              step: { id: "confirm", type: "confirm", message: "Finish signing in?" },
            };
      }
      return reply;
    });
    const { context } = createContext(request, methods, { agentsList });
    const { page } = await mountPage(context);
    await settled(page);
    expect(request.mock.calls.filter(([method]) => method === "openclaw.chat")).toHaveLength(0);
    click(page, "Sign in with ChatGPT");
    await settled(page);
    expect(request).toHaveBeenCalledWith(
      "openclaw.setup.auth.start",
      expect.objectContaining({ authChoice: "codex-sign-in" }),
      { timeoutMs: null },
    );
    expect(page.textContent).toContain("Finish signing in?");
    click(page, "Yes");
    await settled(page);
    expect(autoCalls).toBe(2);
    expect(page.textContent).toContain("Using ChatGPT");
    expect(page.textContent).toContain(reply.reply);
  });

  it("shows unavailable attempts and the terminal fallback", async () => {
    const request = vi.fn(async () => ({
      status: "unavailable",
      alternatives: [],
      attempts: [{ kind: "codex", label: "ChatGPT", error: "Could not prepare the plugin" }],
      installedPlugins: [],
    }));
    const { context } = createContext(request, methods, { agentsList });
    const { page } = await mountPage(context);
    await settled(page);
    expect(page.textContent).toContain("Could not prepare the plugin");
    expect(page.textContent).toContain("openclaw onboard");
    expect(page.textContent).toContain("only connect tools you trust");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses shell-neutral native capabilities for fallback, Gateway selection, and permissions", async () => {
    const openAiSetup = vi.fn();
    const openGateways = vi.fn();
    const reviewPermissions = vi.fn();
    window["__OPENCLAW_NATIVE_SETUP__"] = { openAiSetup, openGateways, reviewPermissions };
    const request = vi.fn(async () => ({
      status: "unavailable",
      alternatives: [],
      attempts: [],
      installedPlugins: [],
    }));
    const { context } = createContext(request, methods, { agentsList });
    const { page } = await mountPage(context);
    await settled(page);
    click(page, "Open AI setup");
    click(page, "Use a different Gateway");
    click(page, "Review permissions");
    expect(openAiSetup).toHaveBeenCalledOnce();
    expect(openGateways).toHaveBeenCalledOnce();
    expect(reviewPermissions).toHaveBeenCalledOnce();
    expect(page.textContent).not.toContain("openclaw onboard");
  });

  it("shows RPC failures and retries without a premature greeting", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auto") {
        throw new Error("Gateway lost its connection");
      }
      return reply;
    });
    const { context } = createContext(request, methods, { agentsList });
    const { page } = await mountPage(context);
    await settled(page);
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Gateway lost its connection",
    );
    expect(request).toHaveBeenCalledTimes(1);
    click(page, "Retry");
    await settled(page);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("persists dismissal across a new custodian store", async () => {
    const request = vi.fn(async (method: string) =>
      method === "openclaw.setup.auto" ? result() : reply,
    );
    const { context } = createContext(request, methods, { agentsList });
    const first = await mountPage(context);
    await settled(first.page);
    first.page.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click();
    await settled(first.page);
    expect(first.page.querySelector(".custodian-setup")).toBeNull();
    first.provider.remove();
    const second = await mountPage(context);
    await settled(second.page);
    expect(second.page.querySelector(".custodian-setup")).toBeNull();
    expect(second.page.textContent).toContain(reply.reply);
  });

  it("ignores an old Gateway result after connection ownership changes", async () => {
    const pending = createDeferred<SetupAutoResult>();
    const request = vi.fn(async () => pending.promise);
    const { context, setGatewaySnapshot } = createContext(request, methods, { agentsList });
    const { page } = await mountPage(context);
    const replacement = vi.fn(async (method: string) =>
      method === "openclaw.setup.auto" ? { ...result(), selected: alternative } : reply,
    );
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
    pending.resolve(result());
    await pending.promise;
    await settled(page);
    expect(page.textContent).toContain("Using Local model");
    expect(page.textContent).not.toContain("Using ChatGPT");
  });

  it.each([false, true])(
    "preserves the existing flow without the advertised method (onboarding=%s)",
    async (onboarding) => {
      const request = vi.fn(async () => reply);
      const { context } = createContext(request, ["openclaw.chat"], { agentsList });
      const { page } = await mountPage(context, { onboarding });
      await settled(page);
      expect(page.querySelector(".custodian-setup")).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(page.querySelector(".custodian__setup-state")).not.toBeNull();
    },
  );
});
