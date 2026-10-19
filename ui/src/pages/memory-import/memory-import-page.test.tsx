/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MigrationsMemoryApplyResult } from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { MemoryImportPage } from "./memory-import-page.tsx";

type MemoryImportPageElement = HTMLElement;
type TestContext = ApplicationContext & { notify(): void };

const waitForMemoryImport = waitForSolid;

async function openImportConfirmation(page: MemoryImportPageElement) {
  await waitForMemoryImport(() =>
    expect(
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']"),
    ).not.toBeNull(),
  );
  page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")?.click();
  await waitForMemoryImport(() =>
    expect(
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']"),
    ).not.toBeNull(),
  );
}

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

function createApplyResult(): MigrationsMemoryApplyResult {
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: 1,
      planned: 0,
      migrated: 1,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [{ id: "memory:codex:MEMORY.md", status: "migrated" }],
  };
}

function createContext(request: ReturnType<typeof vi.fn>): TestContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "research",
    sessionKey: "agent:research:main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewayFixture = createApplicationGateway(snapshot);
  const listeners = new Set<() => void>();
  const subscribe = (notify: () => void) => {
    listeners.add(notify);
    return () => listeners.delete(notify);
  };
  return {
    notify() {
      gatewayFixture.publish(snapshot);
      for (const listener of listeners) {
        listener();
      }
    },
    gateway: gatewayFixture.gateway,
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
  } as unknown as TestContext;
}

async function mountPage(context: ApplicationContext): Promise<MemoryImportPageElement> {
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <MemoryImportPage />, { wrapper: provider.wrapper });
  flush();
  const page = view.container.querySelector<HTMLElement>("openclaw-memory-import-page");
  if (!page) {
    throw new Error("expected memory import page");
  }
  return page;
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MemoryImportPage", () => {
  it("shows the disconnected explanation on a cold offline load and opens the workspace on reconnect", async () => {
    const request = vi.fn(async () => createPlan());
    const context = createContext(request);
    context.gateway.snapshot.phase = "stopped";
    const page = await mountPage(context);

    expect(page.textContent).toContain("Connect to the gateway to import memory.");
    expect(page.querySelector(".memory-import")).toBeNull();
    expect(page.textContent).not.toContain("Memory import requires operator.admin access.");
    expect(request).not.toHaveBeenCalled();

    context.gateway.snapshot.phase = "connected";
    context.notify();
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-import-provider-button']")).not.toBeNull(),
    );
    expect(page.textContent).not.toContain("Connect to the gateway to import memory.");
    expect(page.textContent).toContain("/tmp/openclaw-research");
  });

  it("replans once per owner target and ignores late replies and repeated receipts", async () => {
    const firstPlan = createDeferredCore<ReturnType<typeof createPlan>>();
    const request = vi.fn((_method: string, params: { agentId: string; overwrite: boolean }) =>
      params.agentId === "research" ? firstPlan.promise : Promise.resolve(createPlan("writer")),
    );
    const context = createContext(request);
    const page = await mountPage(context);
    expect(request).toHaveBeenCalledTimes(1);

    context.agents.state.agentsList = {
      defaultId: "writer",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "writer", name: "Writer" }],
    };
    context.agentSelection.state.selectedId = "writer";
    context.notify();
    context.notify();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ agentId: "writer", overwrite: false });
    await waitForMemoryImport(() => expect(page.textContent).toContain("/tmp/openclaw-writer"));

    firstPlan.resolve(createPlan());
    await firstPlan.promise;
    await Promise.resolve();
    flush();
    expect(page.textContent).toContain("/tmp/openclaw-writer");
    expect(page.textContent).not.toContain("/tmp/openclaw-research");

    page.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
    context.notify();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual({ agentId: "writer", overwrite: true });
    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
          ?.disabled,
      ).toBe(false),
    );

    cleanupSolid();
    context.agentSelection.state.selectedId = "research";
    context.agents.state.agentsList = {
      defaultId: "research",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "research", name: "Research" }],
    };
    context.notify();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retains a loaded plan after roster refresh failure and retries the roster on Refresh", async () => {
    const roster = createDeferredCore<unknown>();
    const request = vi.fn((method: string) =>
      method === "agents.list" ? roster.promise : Promise.resolve(createPlan()),
    );
    const context = createContext(request);
    const agents = createAgentCapability(context.gateway);
    // The application shell owns the initial shared roster request.
    const initial = agents.ensureList();
    const page = await mountPage({ ...context, agents });
    try {
      roster.reject(new Error("Agent roster unavailable"));
      request.mockImplementation((method: string) =>
        method === "agents.list" ? createDeferredCore().promise : Promise.resolve(createPlan()),
      );
      await initial;
      flush();
      flush();
      expect(request).toHaveBeenCalledTimes(1);
      expect(page.textContent).toContain("Agent roster unavailable");

      request.mockImplementation((method: string) =>
        Promise.resolve(
          method === "agents.list"
            ? { defaultId: "research", agents: [{ id: "research", name: "Research" }] }
            : createPlan(),
        ),
      );
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Refresh")
        ?.click();
      await waitForMemoryImport(() =>
        expect(page.querySelector("[data-test-id='memory-import-provider-button']")).not.toBeNull(),
      );
      expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(2);
      expect(page.textContent).not.toContain("Agent roster unavailable");
      request.mockImplementation((method: string) =>
        method === "agents.list"
          ? Promise.reject(new Error("Agent roster unavailable"))
          : Promise.resolve(createPlan()),
      );
      await agents.refreshList();
      flush();
      expect(page.querySelector("[data-test-id='memory-import-provider-button']")).not.toBeNull();
      expect(page.textContent).toContain("/tmp/openclaw-research");
      expect(
        request.mock.calls.filter(([method]) => method === "migrations.memory.plan"),
      ).toHaveLength(1);

      request.mockImplementation((method: string) =>
        Promise.resolve(
          method === "agents.list"
            ? { defaultId: "writer", agents: [{ id: "writer", name: "Writer" }] }
            : createPlan("writer"),
        ),
      );
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Refresh")
        ?.click();
      await waitForMemoryImport(() => expect(page.textContent).toContain("/tmp/openclaw-writer"));
      expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(4);
      expect(request).toHaveBeenLastCalledWith(
        "migrations.memory.plan",
        { agentId: "writer", overwrite: false },
        expect.anything(),
      );
      expect(page.textContent).not.toContain("Agent roster unavailable");
      expect(page.textContent).toContain("/tmp/openclaw-writer");
      expect(page.textContent).not.toContain("/tmp/openclaw-research");
    } finally {
      page.parentElement?.remove();
      agents.dispose();
    }
  });

  it("does not plan memory import without admin access", async () => {
    const request = vi.fn();
    const context = createContext(request);
    context.gateway.snapshot.hello = {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      features: { methods: ["migrations.memory.plan"] },
    } as ApplicationGatewaySnapshot["hello"];
    const page = await mountPage(context);

    flush();
    expect(request).not.toHaveBeenCalled();
    expect(page.textContent).toContain("Memory import requires operator.admin access.");
  });

  it("keeps a failed plan stable until the operator explicitly refreshes", async () => {
    const request = vi.fn(async () => {
      throw new Error("planning unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
    });
    const context = createContext(request);
    const page = await mountPage(context);

    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(1));
    flush();
    await Promise.resolve();
    context.notify();
    flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(page.textContent).toContain("planning unavailable: OPENAI_API_KEY=sk-123...cdef");
    expect(page.textContent).not.toContain("sk-1234567890abcdef");

    const refresh = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    if (!refresh) {
      throw new Error("expected Refresh button");
    }
    refresh.click();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(2));
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

    await openImportConfirmation(page);
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();

    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(3));
    flush();
    expect(page.textContent).toContain("post-apply planning unavailable");
    expect(page.textContent).toContain("replacement interrupted");
    expect(page.textContent).toContain("/tmp/migration-report");
    expect(
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
        ?.disabled,
    ).toBe(true);
  });

  it("admits one same-turn import and unlocks after its successful refresh", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "migrations.memory.apply") {
        return { ...createApplyResult(), reportDir: "/tmp/migration-report" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));

    await openImportConfirmation(page);
    const confirm = page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']");
    confirm?.click();
    confirm?.click();
    expect(request).toHaveBeenCalledTimes(2);

    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
          ?.disabled,
      ).toBe(false),
    );
  });

  it("reuses the same frozen idempotency key when a failed apply is retried", async () => {
    let applyRequests = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "migrations.memory.apply") {
        applyRequests += 1;
        if (applyRequests === 1) {
          throw new Error("response lost");
        }
        return createApplyResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));

    await openImportConfirmation(page);
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();
    await waitForMemoryImport(() => expect(page.textContent).toContain("response lost"));
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();

    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(4));
    const firstApply = request.mock.calls[1]?.[1] as { idempotencyKey?: string } | undefined;
    const retryApply = request.mock.calls[2]?.[1] as { idempotencyKey?: string } | undefined;
    expect(firstApply?.idempotencyKey).toMatch(/\S/u);
    expect(retryApply).toEqual(firstApply);
  });

  it("retains selections, dates, previews and confirmation across a same-client reconnect", async () => {
    const plan = createPlan();
    plan.providers[0]!.items.push({
      ...plan.providers[0]!.items[0]!,
      id: "memory:codex:other.md",
      details: { collectionId: "other", collectionLabel: "Other", relativePath: "other.md" },
    });
    const request = vi.fn(async (method: string, params: { agentId?: string }) => {
      if (method === "migrations.memory.plan") {
        return { ...plan, agentId: params.agentId ?? "research" };
      }
      if (method === "memory.sessionBackfill.preview") {
        return {
          days: 1,
          candidates: 1,
          staged: 0,
          perDay: [{ day: "2026-07-01", candidateCount: 1, sample: ["Retained preview"] }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const context = createContext(request);
    const page = await mountPage(context);
    await waitForMemoryImport(() =>
      expect(
        page.querySelectorAll(".memory-import__collection input[type='checkbox']"),
      ).toHaveLength(2),
    );
    page
      .querySelectorAll<HTMLInputElement>(".memory-import__collection input[type='checkbox']")[1]!
      .click();
    const date = page.querySelector<HTMLInputElement>("input[type='date']")!;
    date.value = "2026-07-01";
    date.dispatchEvent(new Event("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-preview']")!.click();
    await waitForMemoryImport(() => expect(page.textContent).toContain("Retained preview"));
    await openImportConfirmation(page);

    context.gateway.snapshot.phase = "stopped";
    context.gateway.snapshot.hello = null;
    context.notify();
    flush();
    flush();
    expect(
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.disabled,
    ).toBe(true);
    expect(page.querySelector<HTMLInputElement>("input[type='date']")?.value).toBe("2026-07-01");
    expect(page.textContent).toContain("Retained preview");

    context.gateway.snapshot.phase = "connected";
    context.notify();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForMemoryImport(() =>
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.disabled,
      ).toBe(false),
    );
    expect(
      [
        ...page.querySelectorAll<HTMLInputElement>(
          ".memory-import__collection input[type='checkbox']",
        ),
      ].map((input) => input.checked),
    ).toEqual([true, false]);
    expect(page.querySelector<HTMLInputElement>("input[type='date']")?.value).toBe("2026-07-01");
    expect(page.textContent).toContain("Retained preview");

    page
      .querySelector<HTMLButtonElement>(".memory-import__confirm button:not([data-test-id])")!
      .click();
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback']")!.click();
    flush();
    context.gateway.snapshot.phase = "reconnecting";
    context.notify();
    flush();
    expect(
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback-confirm']")
        ?.disabled,
    ).toBe(true);
    context.gateway.snapshot.phase = "connected";
    context.notify();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(4));
    expect(page.querySelector("[data-test-id='memory-backfill-rollback-confirm']")).not.toBeNull();

    const replacementClient = { request } as unknown as GatewayBrowserClient;
    context.gateway.snapshot.client = replacementClient;
    context.gateway.snapshot.phase = "connected";
    context.notify();
    await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(5));
    expect(page.querySelector("[data-test-id='memory-import-confirm']")).toBeNull();
    expect(page.querySelector("[data-test-id='memory-backfill-rollback-confirm']")).toBeNull();
    expect(page.querySelector<HTMLInputElement>("input[type='date']")?.value).toBe("");
    expect(page.textContent).not.toContain("Retained preview");

    context.gateway.snapshot.hello = gatewayHelloForMethods([], ["operator.read"]);
    context.notify();
    await waitForMemoryImport(() => expect(page.querySelector(".memory-import")).toBeNull());
    expect(page.textContent).not.toContain("/tmp/openclaw-research");
  });

  it.each(["account", "recovery"] as const)(
    "retires protected plans and drafts when the same client's %s identity changes",
    async (identity) => {
      const replacementPlan = createDeferredCore<ReturnType<typeof createPlan>>();
      let planRequests = 0;
      const request = vi.fn((method: string) => {
        if (method === "migrations.memory.plan") {
          planRequests += 1;
          return planRequests === 1 ? Promise.resolve(createPlan()) : replacementPlan.promise;
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const context = createContext(request);
      context.gateway.snapshot.selfUser = { id: "first", name: "First" };
      const hello = gatewayHelloForMethods(["memory.sessionBackfill.preview"]);
      context.gateway.snapshot.hello = {
        ...hello,
        auth: { ...hello.auth, recoveryScope: "first" },
      };
      const page = await mountPage(context);
      await openImportConfirmation(page);
      const date = page.querySelector<HTMLInputElement>("input[type='date']")!;
      date.value = "2026-07-01";
      date.dispatchEvent(new Event("input", { bubbles: true }));
      const confirm = page.querySelector<HTMLButtonElement>(
        "[data-test-id='memory-import-confirm']",
      )!;

      if (identity === "account") {
        context.gateway.snapshot.selfUser = { id: "second", name: "Second" };
      } else {
        context.gateway.snapshot.hello = {
          ...hello,
          auth: { ...hello.auth, recoveryScope: "second" },
        };
      }
      context.notify();
      // A retained button cannot submit the previous identity's confirmation before rendering catches up.
      confirm.click();
      expect(request.mock.calls.every(([method]) => method === "migrations.memory.plan")).toBe(
        true,
      );
      await waitForMemoryImport(() => expect(planRequests).toBe(2));
      expect(page.querySelector("[data-test-id='memory-import-confirm']")).toBeNull();
      expect(page.querySelector<HTMLInputElement>("input[type='date']")?.value).toBe("");
      expect(page.textContent).not.toContain("/tmp/openclaw-research");
      replacementPlan.resolve(createPlan());
      await waitForMemoryImport(() =>
        expect(page.querySelector("[data-test-id='memory-import-provider-button']")).not.toBeNull(),
      );
    },
  );

  it.each(["disconnect", "roster loss"] as const)(
    "preserves an attempted import key across %s",
    async (interruption) => {
      const result = createApplyResult();
      let finishFirstApply!: (value: typeof result) => void;
      let applyRequests = 0;
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (method === "migrations.memory.plan") {
          return createPlan();
        }
        if (method === "migrations.memory.apply") {
          applyRequests += 1;
          if (applyRequests === 1) {
            return await new Promise<typeof result>((resolve) => {
              finishFirstApply = resolve;
            });
          }
          return result;
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const context = createContext(request);
      const roster = context.agents.state.agentsList;
      const page = await mountPage(context);

      await openImportConfirmation(page);
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();
      await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(2));
      const firstApply = request.mock.calls[1]?.[1] as { idempotencyKey?: string } | undefined;

      if (interruption === "disconnect") {
        context.gateway.snapshot.phase = "stopped";
      } else {
        context.agents.state.agentsList = null;
        context.agents.state.agentsError = "Agent roster unavailable";
      }
      context.notify();
      flush();
      expect(
        page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.disabled ??
          true,
      ).toBe(true);
      finishFirstApply(result);
      await Promise.resolve();

      if (interruption === "disconnect") {
        context.gateway.snapshot.phase = "connected";
      } else {
        context.agents.state.agentsList = roster;
        context.agents.state.agentsError = null;
      }
      context.notify();
      await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(3));
      await waitForMemoryImport(() =>
        expect(page.querySelector("[data-test-id='memory-import-confirm']")).not.toBeNull(),
      );
      page.querySelector<HTMLButtonElement>("[data-test-id='memory-import-confirm']")?.click();
      await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(4));

      const retryApply = request.mock.calls[3]?.[1] as { idempotencyKey?: string } | undefined;
      expect(firstApply?.idempotencyKey).toMatch(/\S/u);
      expect(retryApply).toEqual(firstApply);
    },
  );

  it.each(["import", "rollback"] as const)(
    "retires %s confirmation when the shared agent changes and its next plan fails",
    async (operation) => {
      const nextPlan = createDeferredCore<ReturnType<typeof createPlan>>();
      const request = vi.fn(async (method: string, params: { agentId?: string }) => {
        if (method === "migrations.memory.plan") {
          return params.agentId === "writer" ? nextPlan.promise : createPlan();
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const context = createContext(request);
      const agents: ApplicationContext["agents"] = {
        ...context.agents,
        state: {
          ...context.agents.state,
          agentsList: {
            defaultId: "research",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "research", name: "Research" },
              { id: "writer", name: "Writer" },
            ],
          },
        },
      };
      const selection = createAgentSelectionCapability(context.gateway, agents);
      const page = await mountPage({ ...context, agents, agentSelection: selection });
      try {
        await waitForMemoryImport(() =>
          expect(
            page.querySelector("[data-test-id='memory-import-provider-button']"),
          ).not.toBeNull(),
        );
        if (operation === "import") {
          await openImportConfirmation(page);
        } else {
          page
            .querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback']")
            ?.click();
        }
        const selector =
          operation === "import"
            ? "[data-test-id='memory-import-confirm']"
            : "[data-test-id='memory-backfill-rollback-confirm']";
        await waitForMemoryImport(() => expect(page.querySelector(selector)).not.toBeNull());
        const confirm = page.querySelector<HTMLButtonElement>(selector);

        selection.set("writer");
        confirm?.click();
        expect(request).toHaveBeenCalledTimes(2);

        await waitForMemoryImport(() => expect(request).toHaveBeenCalledTimes(2));
        expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "writer" });
        expect(page.querySelector(selector)).toBeNull();
        nextPlan.reject(new Error("Writer plan unavailable"));
        await waitForMemoryImport(() =>
          expect(page.textContent).toContain("Writer plan unavailable"),
        );
        expect(page.querySelector(selector)).toBeNull();
        expect(request.mock.calls.every(([method]) => method === "migrations.memory.plan")).toBe(
          true,
        );
      } finally {
        cleanupSolid();
        selection.dispose();
      }
    },
  );

  it("previews past-session candidates with the selected date range", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "memory.sessionBackfill.preview") {
        return {
          days: 1,
          candidates: 2,
          staged: 0,
          truncated: true,
          perDay: [
            { day: "2026-07-01", candidateCount: 2, sample: ["First memory", "Second memory"] },
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-preview']")).not.toBeNull(),
    );
    const dates = page.querySelectorAll<HTMLInputElement>(
      ".memory-import__backfill-dates input[type='date']",
    );
    dates[0]!.value = "2026-07-01";
    dates[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    dates[1]!.value = "2026-07-31";
    dates[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-preview']")?.click();

    await waitForMemoryImport(() => expect(page.textContent).toContain("First memory"));
    expect(page.textContent).toContain("preview shows the first bounded batch");
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.preview",
      { agentId: "research", from: "2026-07-01", to: "2026-07-31", limitDays: 14 },
    ]);
  });

  it("applies backfill chunks until a call returns zero new candidates", async () => {
    let applyCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "memory.sessionBackfill.apply") {
        applyCalls += 1;
        if (applyCalls === 1) {
          return {
            days: 2,
            candidates: 3,
            staged: 2,
            perDay: [{ day: "2026-07-01", candidateCount: 3, sample: [] }],
            cursor: { advanced: true, exhausted: false, hasMore: true },
          };
        }
        if (applyCalls === 2) {
          return {
            days: 1,
            candidates: 1,
            staged: 1,
            perDay: [{ day: "2026-07-01", candidateCount: 1, sample: [] }],
            cursor: { advanced: true, exhausted: false, hasMore: false },
          };
        }
        return {
          days: 0,
          candidates: 0,
          staged: 0,
          perDay: [],
          cursor: { advanced: false, exhausted: true, hasMore: false },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-apply']")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-apply']")?.click();

    await waitForMemoryImport(() =>
      expect(page.textContent).toContain("3 staged; promotion happens via dreaming"),
    );
    expect(applyCalls).toBe(3);
    expect(page.textContent).toContain("4 session candidates processed");
    expect(page.textContent).toContain("1 day processed");

    const from = page.querySelector<HTMLInputElement>(
      ".memory-import__backfill-dates input[type='date']",
    );
    if (!from) {
      throw new Error("expected backfill from-date input");
    }
    from.value = "2026-07-01";
    from.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(page.textContent).not.toContain("3 staged; promotion happens via dreaming");
  });

  it("confirms rollback and surfaces gateway errors", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      if (method === "memory.sessionBackfill.rollback") {
        throw new Error("rollback unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-rollback']")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback']")?.click();
    await waitForMemoryImport(() =>
      expect(
        page.querySelector("[data-test-id='memory-backfill-rollback-confirm']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback-confirm']")
      ?.click();

    await waitForMemoryImport(() => expect(page.textContent).toContain("rollback unavailable"));
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.rollback",
      { agentId: "research" },
    ]);
  });
});
