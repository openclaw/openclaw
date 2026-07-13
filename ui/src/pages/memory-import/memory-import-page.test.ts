/* @vitest-environment jsdom */

import { ContextProvider } from "@lit/context";
import { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import "./memory-import-page.ts";

const PROVIDER_TAG = "test-memory-import-context-provider";

class MemoryImportContextProvider extends LitElement {
  private readonly provider = new ContextProvider(this, { context: applicationContext });

  setContext(context: ApplicationContext) {
    this.provider.setValue(context);
  }
}

if (!customElements.get(PROVIDER_TAG)) {
  customElements.define(PROVIDER_TAG, MemoryImportContextProvider);
}

type MemoryImportPageElement = HTMLElement & {
  updateComplete: Promise<boolean>;
};

function createContext(request: ReturnType<typeof vi.fn>): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: "research",
    sessionKey: "agent:research:main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    gateway: { snapshot, subscribe },
    agents: {
      state: {
        client,
        connected: true,
        agentsLoading: false,
        agentsError: null,
        agentsList: {
          defaultId: "research",
          agents: [{ id: "research", name: "Research" }],
        },
      },
      ensureList: vi.fn(),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: "research" },
      set: vi.fn(),
      subscribe,
    },
  } as unknown as ApplicationContext;
}

async function mountPage(context: ApplicationContext): Promise<MemoryImportPageElement> {
  const provider = document.createElement(PROVIDER_TAG) as MemoryImportContextProvider;
  const page = document.createElement("openclaw-memory-import-page") as MemoryImportPageElement;
  provider.setContext(context);
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MemoryImportPage", () => {
  it("keeps a failed plan stable until the operator explicitly refreshes", async () => {
    const request = vi.fn(async () => {
      throw new Error("planning unavailable");
    });
    const page = await mountPage(createContext(request));

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await page.updateComplete;
    await Promise.resolve();
    await page.updateComplete;
    expect(request).toHaveBeenCalledTimes(1);
    expect(page.textContent).toContain("planning unavailable");

    const refresh = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    if (!refresh) {
      throw new Error("expected Refresh button");
    }
    refresh.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
});
