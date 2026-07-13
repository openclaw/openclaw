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
  requestUpdate(): void;
};

function createPlan(agentId = "research") {
  const workspace = `/tmp/openclaw-${agentId}`;
  return {
    agentId,
    workspace,
    providers: [
      {
        providerId: "codex",
        label: "Codex",
        description: "Import Codex memory.",
        planFingerprint: "a".repeat(64),
        found: true,
        source: "/tmp/codex",
        target: workspace,
        summary: {
          total: 1,
          planned: 1,
          migrated: 0,
          skipped: 0,
          conflicts: 0,
          errors: 0,
          sensitive: 0,
        },
        items: [
          {
            id: "memory:codex:MEMORY.md",
            status: "planned",
            source: "/tmp/codex/MEMORY.md",
            target: `${workspace}/memory/imports/codex/MEMORY.md`,
            details: {
              collectionId: "codex",
              collectionLabel: "Codex",
              relativePath: "MEMORY.md",
            },
          },
        ],
      },
    ],
  };
}

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

  it("keeps apply recovery results visible when the follow-up plan fails", async () => {
    let planRequests = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        planRequests += 1;
        if (planRequests > 1) {
          throw new Error("post-apply planning unavailable");
        }
        return createPlan();
      }
      if (method === "migrations.memory.apply") {
        return {
          providerId: "codex",
          source: "/tmp/codex",
          summary: {
            total: 1,
            planned: 0,
            migrated: 0,
            skipped: 0,
            conflicts: 0,
            errors: 1,
            sensitive: 0,
          },
          items: [
            {
              id: "memory:codex:MEMORY.md",
              status: "error",
              reason: "replacement interrupted",
              details: {
                recoveryRecordPath: "/tmp/migration-report/recovery-required.json",
              },
            },
          ],
          reportDir: "/tmp/migration-report",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));

    await vi.waitFor(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
      ?.click();
    await vi.waitFor(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']"),
      ).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await page.updateComplete;
    expect(page.textContent).toContain("post-apply planning unavailable");
    expect(page.textContent).toContain("replacement interrupted");
    expect(page.textContent).toContain("/tmp/migration-report");
    expect(
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
        ?.disabled,
    ).toBe(true);
  });

  it("drops pending state and rejects confirmation when shared agent selection changes", async () => {
    const request = vi.fn(async (method: string, params: { agentId?: string }) => {
      if (method === "migrations.memory.plan") {
        return createPlan(params.agentId ?? "research");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const context = createContext(request);
    const mutableContext = context as unknown as {
      agents: {
        state: {
          agentsList: {
            defaultId: string;
            agents: Array<{ id: string; name: string }>;
          };
        };
      };
      agentSelection: { state: { selectedId: string } };
    };
    mutableContext.agents.state.agentsList.agents.push({ id: "writer", name: "Writer" });
    const page = await mountPage(context);

    await vi.waitFor(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
      ?.click();
    await vi.waitFor(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']"),
      ).not.toBeNull(),
    );

    mutableContext.agentSelection.state.selectedId = "writer";
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();
    expect(request).toHaveBeenCalledTimes(1);

    page.requestUpdate();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "writer" });
    expect(page.querySelector("[data-test-id='memory-import-confirm']")).toBeNull();
  });
});
