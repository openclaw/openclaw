/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import "./custodian-page.ts";

const CUSTODIAN_QUESTION_MARKER = "openclaw-user-input";

type TestCustodianPage = HTMLElement & { updateComplete: Promise<boolean> };

type ContextHarness = {
  context: ApplicationContext;
  setGatewaySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  setGatewayUrl: (gatewayUrl: string) => void;
};

function createContext(request: ReturnType<typeof vi.fn>): ContextHarness {
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["openclaw.chat"] },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const connection = {
    gatewayUrl: "ws://gateway.test/control",
    token: "",
    bootstrapToken: "",
    password: "",
  };
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection,
    subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  const context = {
    gateway,
    basePath: "",
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    context,
    setGatewaySnapshot: (patch) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    setGatewayUrl: (gatewayUrl) => {
      connection.gatewayUrl = gatewayUrl;
    },
  };
}

async function mountPage(context: ApplicationContext): Promise<{
  page: TestCustodianPage;
  provider: ApplicationContextProvider;
}> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-custodian-page") as TestCustodianPage;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

describe("custodian page", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("starts onboarding chat, renders marked choices, and replies with the exact label", async () => {
    const question = {
      id: "access",
      header: "Access",
      question: "How should OpenClaw work?",
      options: [
        { label: "Full access", description: "Use announced defaults", recommended: true },
        { label: "Ask first" },
      ],
      isOther: false,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: `Choose one.\n<!-- ${CUSTODIAN_QUESTION_MARKER}\n${JSON.stringify(question)}\n-->`,
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Good choice.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    const card = page.querySelector("openclaw-option-card")!;
    await card.updateComplete;
    expect(page.querySelector(".option-card__choice--recommended")?.textContent).toContain(
      "Full access",
    );
    page.querySelector<HTMLButtonElement>('[data-option-value="Ask first"]')!.click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(request.mock.calls[0]?.[0]).toBe("openclaw.chat");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "onboarding" });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      welcomeVariant: "onboarding",
      message: "Ask first",
    });
    expect(page.querySelector<HTMLButtonElement>('[data-option-value="Ask first"]')?.disabled).toBe(
      true,
    );
  });

  it("keeps failed sensitive replies masked for correction and retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Enter the token.",
        sensitive: true,
        action: "none",
      })
      .mockRejectedValueOnce(new Error("Request failed"));
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    const input = page.querySelector<HTMLInputElement>(
      '.custodian__composer input[type="password"]',
    )!;
    input.value = "test-secret";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__composer button")!.click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    await page.updateComplete;
    expect(page.querySelector('.custodian__composer input[type="password"]')).not.toBeNull();
    expect(page.textContent).toContain("Sensitive reply sent");
    expect(page.innerHTML).not.toContain("test-secret");
  });

  it("preserves the onboarding session across a same-gateway reconnect", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Hello from OpenClaw.",
      action: "none",
    });
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    setGatewaySnapshot({ client: null, connected: false, reconnecting: true });
    await page.updateComplete;
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
    });
    await page.updateComplete;

    expect(request).toHaveBeenCalledOnce();
    expect(page.textContent).toContain("Hello from OpenClaw.");
  });

  it("offers retry when a connected client is replaced mid-request", async () => {
    const request = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<never>(() => {
          // Keep the original request pending while the gateway replaces its client.
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Hello after reconnect.",
        action: "none",
      });
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    setGatewaySnapshot({ client: { request } as unknown as GatewayBrowserClient });
    await vi.waitFor(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Gateway connection changed",
      ),
    );
    page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(page.textContent).toContain("Hello after reconnect."));
  });

  it("clears the prior conversation when the gateway changes while offline", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Gateway A conversation.",
      action: "none",
    });
    const { context, setGatewaySnapshot, setGatewayUrl } = createContext(request);
    const { page } = await mountPage(context);
    await vi.waitFor(() => expect(page.textContent).toContain("Gateway A conversation."));

    setGatewayUrl("ws://gateway-b.test/control");
    setGatewaySnapshot({ client: null, connected: false, reconnecting: true });
    await vi.waitFor(() => expect(page.textContent).not.toContain("Gateway A conversation."));

    expect(page.querySelector('[role="alert"] button')).toBeNull();
  });

  it("sends skip as a reply and dismisses the question", async () => {
    const question = {
      id: "access",
      header: "Access",
      question: "How should OpenClaw work?",
      options: [{ label: "Full access" }, { label: "Ask first" }],
      isOther: false,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: `Choose one.\n<!-- ${CUSTODIAN_QUESTION_MARKER}\n${JSON.stringify(question)}\n-->`,
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Moving on.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".option-card__skip")!.click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "Skip for now" });
    expect(page.querySelector("openclaw-option-card")).toBeNull();
  });

  it("retires a structured question after a freeform reply", async () => {
    const question = {
      id: "access",
      header: "Access",
      question: "How should OpenClaw work?",
      options: [{ label: "Full access" }, { label: "Ask first" }],
      isOther: false,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: `Choose one.\n<!-- ${CUSTODIAN_QUESTION_MARKER}\n${JSON.stringify(question)}\n-->`,
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Understood.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    const input = page.querySelector<HTMLTextAreaElement>(".custodian__composer textarea")!;
    input.value = "Something else";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".custodian__composer button")!.click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "Something else" });
    expect(page.querySelector<HTMLButtonElement>('[data-option-value="Ask first"]')?.disabled).toBe(
      true,
    );
  });

  it("exits setup through normal chat navigation", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Hello.",
      action: "none",
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".custodian__header button")!.click();

    expect(context.navigate).toHaveBeenCalledWith("chat");
  });
});
