/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./onboarding-memory-import-solid.tsx";

type OnboardingMemoryImportElement = HTMLElement & {
  active: boolean;
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
};

async function waitForAction(
  element: OnboardingMemoryImportElement,
  action: "import" | "skip" | "continue" = "import",
) {
  const selector = `[data-test-id='onboarding-memory-import-${action}']`;
  await waitForSolid(() => expect(element.querySelector(selector)).not.toBeNull());
  return element.querySelector<HTMLButtonElement>(selector)!;
}
const guardKey = "openclaw.onboarding.memory-import";

function summary(migrated = 0, skipped = 0, planned = 0, conflicts = 0) {
  return {
    total: migrated + skipped + planned + conflicts,
    planned,
    migrated,
    skipped,
    conflicts,
    errors: 0,
    sensitive: 0,
  };
}

function createProvider(providerId: string, fingerprint: string) {
  return {
    providerId,
    label: providerId === "codex" ? "Codex" : "Claude Code",
    planFingerprint: fingerprint,
    found: true,
    source: `/tmp/${providerId}`,
    target: "/tmp/openclaw-research",
    summary: summary(0, 0, 1, 1),
    items: (
      [
        ["MEMORY.md", "planned"],
        ["existing.md", "conflict"],
      ] as const
    ).map(([file, status]) => ({
      id: `memory:${providerId}:${file}`,
      status,
      source: `/tmp/${providerId}/${file}`,
    })),
  };
}

function createPlan(providerIds = ["codex"]) {
  return {
    agentId: "research",
    workspace: "/tmp/openclaw-research",
    providers: providerIds.map((providerId, index) =>
      createProvider(providerId, String.fromCharCode(97 + index).repeat(64)),
    ),
  };
}

function createApplyResult(providerId: string, migrated = 1, skipped = 0) {
  return {
    providerId,
    source: `/tmp/${providerId}`,
    summary: summary(migrated, skipped),
    items: [],
  };
}

function successfulRequest(
  providerIds = ["codex"],
  apply = (providerId: string) => Promise.resolve(createApplyResult(providerId)),
) {
  return vi.fn(async (method: string, params?: { providerId?: string }) =>
    method === "migrations.memory.plan"
      ? createPlan(providerIds)
      : await apply(params?.providerId ?? "unknown"),
  );
}

function expectUnOffered(element: OnboardingMemoryImportElement) {
  expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(sessionStorage.getItem(guardKey)).toBeNull();
}
const contextNotifications = new WeakMap<ApplicationContext, () => void>();

function createContext(
  request: ReturnType<typeof vi.fn>,
  options: { connected?: boolean; admin?: boolean; agentsLoaded?: boolean } = {},
) {
  const connected = options.connected ?? true;
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    client: connected ? client : null,
    phase: connected ? "connected" : "stopped",
    hello: {
      auth: {
        role: "operator",
        scopes: options.admin === false ? ["operator.read"] : ["operator.admin"],
      },
    } as ApplicationGatewaySnapshot["hello"],
    assistantAgentId: "research",
    sessionKey: "agent:research:main",
  });
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const context = {
    gateway: { snapshot, subscribe },
    agents: {
      state: {
        client: connected ? client : null,
        connected,
        agentsLoading: false,
        agentsError: null,
        agentsList:
          options.agentsLoaded === false
            ? null
            : {
                defaultId: "research",
                agents: [{ id: "research", name: "Research" }],
              },
      },
      ensureList: vi.fn(async () => null),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: "research", scopeId: "research" },
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe,
    },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  contextNotifications.set(context, () => listeners.forEach((listener) => listener()));
  return context;
}

async function mount(
  context: ApplicationContext,
  active = true,
): Promise<OnboardingMemoryImportElement> {
  const element = document.createElement(
    "openclaw-onboarding-memory-import",
  ) as OnboardingMemoryImportElement;
  element.context = context;
  element.active = active;
  mountSolid(() => element);
  await element.updateComplete;
  return element;
}

async function startImport(request: ReturnType<typeof vi.fn>) {
  const element = await mount(createContext(request));
  (await waitForAction(element)).click();
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("OnboardingMemoryImport", () => {
  it.each([
    { name: "onboarding is inactive", active: false, connected: true, admin: true },
    { name: "gateway is disconnected", active: true, connected: false, admin: true },
    { name: "operator lacks admin access", active: true, connected: true, admin: false },
  ])("stays hidden when $name", async ({ active, connected, admin }) => {
    const request = vi.fn();
    const element = await mount(createContext(request, { connected, admin }), active);
    await Promise.resolve();
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("loads agents once through its own notifications and retries on a later notification", async () => {
    const request = vi.fn();
    const context = createContext(request, { agentsLoaded: false });
    const notify = contextNotifications.get(context)!;
    const ensureList = vi.mocked(context.agents.ensureList);
    const pendingList = createDeferred();
    ensureList.mockImplementationOnce(async () => {
      context.agents.state.agentsLoading = true;
      notify();
      await pendingList.promise;
      context.agents.state.agentsLoading = false;
      context.agents.state.agentsError = "Agent list unavailable";
      notify();
      return null;
    });
    const element = await mount(context);
    await waitForSolid(() => expect(ensureList).toHaveBeenCalledTimes(1));
    expect(request).not.toHaveBeenCalled();
    notify();
    pendingList.resolve();
    await ensureList.mock.results[0]!.value;
    await element.updateComplete;
    expect(ensureList).toHaveBeenCalledTimes(1);

    notify();
    await waitForSolid(() => expect(ensureList).toHaveBeenCalledTimes(2));
  });

  it("sets the guard after a successful plan with no offers", async () => {
    const request = vi.fn(async () => createPlan([]));
    const element = await mount(createContext(request));
    await waitForSolid(() => expect(sessionStorage.getItem(guardKey)).toBe("done"));
    expect(request).toHaveBeenCalledWith(
      "migrations.memory.plan",
      { agentId: "research", overwrite: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("keeps planning errors silent and unguarded", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const element = await mount(createContext(request));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
    await element.updateComplete;
    expectUnOffered(element);
  });

  it("keeps provider-level planning errors unguarded", async () => {
    const provider = createProvider("codex", "a".repeat(64));
    const request = vi.fn(async () => ({
      ...createPlan([]),
      providers: [
        {
          ...provider,
          error: "scan unavailable",
          found: false,
          items: [],
          planFingerprint: undefined,
        },
      ],
    }));
    const element = await mount(createContext(request));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
    await element.updateComplete;
    expectUnOffered(element);
  });

  it("discards a plan when its gateway changes before display", async () => {
    const pendingPlan = createDeferred<ReturnType<typeof createPlan>>();
    const request = vi.fn(() => pendingPlan.promise);
    const context = createContext(request);
    const element = await mount(context);
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
    context.gateway.snapshot.client = createContext(vi.fn()).gateway.snapshot.client;
    pendingPlan.resolve(createPlan());
    await Promise.resolve();
    await element.updateComplete;
    expectUnOffered(element);
  });

  it("aborts pending planning when onboarding deactivates without completing the guard", async () => {
    const pendingPlan = createDeferred<ReturnType<typeof createPlan>>();
    let signal!: AbortSignal;
    const request = vi.fn(
      async (_method: string, _params: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return await pendingPlan.promise;
      },
    );
    const element = await mount(createContext(request));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
    expect(signal.aborted).toBe(false);
    element.active = false;
    await element.updateComplete;
    await waitForSolid(() => expect(signal.aborted).toBe(true));

    pendingPlan.resolve(createPlan([]));
    await request.mock.results[0]!.value;
    await element.updateComplete;
    expectUnOffered(element);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends frozen provider plans with fresh idempotency keys", async () => {
    const request = successfulRequest(["codex", "claude"]);
    const randomUuid = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    await startImport(request);

    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
    const applyCalls = request.mock.calls.filter(
      ([method]) => method === "migrations.memory.apply",
    );
    expect(applyCalls.map(([, params]) => params)).toEqual(
      ["codex", "claude"].map((providerId, index) => ({
        idempotencyKey: `00000000-0000-4000-8000-00000000000${index + 1}`,
        agentId: "research",
        providerId,
        planFingerprint: (index === 0 ? "a" : "b").repeat(64),
        itemIds: [`memory:${providerId}:MEMORY.md`],
        overwrite: false,
      })),
    );
    expect(randomUuid).toHaveBeenCalledTimes(2);
  });

  it("uses same-turn selection and admits only one import while completion is pending", async () => {
    const pendingApply = createDeferred<ReturnType<typeof createApplyResult>>();
    const request = successfulRequest(["codex", "claude"], () => pendingApply.promise);
    const element = await mount(createContext(request));
    const button = await waitForAction(element);
    const codex = element.querySelector<HTMLInputElement>("[data-provider-id='codex'] input")!;
    codex.checked = false;
    codex.dispatchEvent(new Event("change", { bubbles: true }));
    button.click();
    button.click();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(
      "migrations.memory.apply",
      expect.objectContaining({ providerId: "claude" }),
    );
    const cancel = new Event("modal-cancel", { bubbles: true, cancelable: true });
    element.querySelector("openclaw-modal-dialog")!.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    pendingApply.resolve(createApplyResult("claude"));
    await waitForAction(element, "continue");
    expect(element.textContent).toContain("Migrated 1, skipped 0");
  });

  it("retires a displayed offer synchronously on disconnect", async () => {
    const request = successfulRequest();
    const element = await mount(createContext(request));
    const button = await waitForAction(element);
    element.remove();
    button.click();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("drops a displayed plan when the gateway context changes", async () => {
    const originalRequest = successfulRequest();
    const replacementRequest = successfulRequest();
    const element = await mount(createContext(originalRequest));
    await waitForAction(element);
    element.context = createContext(replacementRequest);
    await element.updateComplete;
    await waitForSolid(() => expect(replacementRequest).toHaveBeenCalled());
    expect(replacementRequest.mock.calls[0]?.[0]).toBe("migrations.memory.plan");
    expect(originalRequest).toHaveBeenCalledTimes(1);
    (await waitForAction(element)).click();
    await waitForSolid(() =>
      expect(
        replacementRequest.mock.calls.filter((call) => call[0] === "migrations.memory.apply"),
      ).toHaveLength(1),
    );
    expect(
      originalRequest.mock.calls.filter((call) => call[0] === "migrations.memory.apply"),
    ).toHaveLength(0);
  });

  it("shows partial apply failures inline", async () => {
    const request = successfulRequest(undefined, async () => {
      const result = createApplyResult("codex");
      result.summary.errors = 1;
      result.summary.total = 2;
      return result;
    });
    const element = await startImport(request);
    await waitForSolid(() => expect(element.textContent).toContain("1 failed"));
    expect(element.textContent).toContain("Migrated 1");
  });

  it("restores pending import results after reactivation without exposing them to another gateway", async () => {
    const pendingApply = createDeferred<ReturnType<typeof createApplyResult>>();
    const request = successfulRequest(undefined, () => pendingApply.promise);
    const element = await startImport(request);
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    element.active = false;
    await element.updateComplete;
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
    element.active = true;
    await element.updateComplete;
    pendingApply.resolve(createApplyResult("codex"));
    await waitForAction(element, "continue");
    expect(element.textContent).toContain("Migrated 1, skipped 0");
    expect(request).toHaveBeenCalledTimes(2);
    element.context = createContext(vi.fn(async () => createPlan()));
    await element.updateComplete;
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("shows a completed provider while the next import is pending", async () => {
    const pendingApply = createDeferred<ReturnType<typeof createApplyResult>>();
    const request = successfulRequest(["codex", "claude"], async (providerId) =>
      providerId === "claude" ? await pendingApply.promise : createApplyResult("codex"),
    );
    const element = await startImport(request);
    try {
      await waitForSolid(() => {
        expect(request).toHaveBeenCalledTimes(3);
        expect(element.querySelector("[data-provider-id='codex']")?.textContent).toContain(
          "Migrated 1, skipped 0",
        );
        expect(element.querySelector("[data-provider-id='claude']")?.textContent).toContain(
          "Importing",
        );
      });
    } finally {
      pendingApply.resolve(createApplyResult("claude"));
    }
    await waitForAction(element, "continue");
  });

  it("sets the guard when skipped", async () => {
    const request = vi.fn(async () => createPlan());
    const context = createContext(request);
    const element = await mount(context);
    (await waitForAction(element, "skip")).click();
    await element.updateComplete;
    expect(sessionStorage.getItem(guardKey)).toBe("done");
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
    const remounted = await mount(context);
    expect(remounted.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("continues with later providers after a provider error", async () => {
    const request = successfulRequest(["codex", "claude"], async (providerId) => {
      if (providerId === "codex") {
        throw new Error("Codex import unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
      }
      return createApplyResult("claude", 1, 0);
    });
    const element = await startImport(request);
    await waitForAction(element, "continue");
    const applyProviders = request.mock.calls
      .filter(([method]) => method === "migrations.memory.apply")
      .map(([, params]) => params?.providerId);
    expect(applyProviders).toEqual(["codex", "claude"]);
    expect(element.textContent).toContain("Codex import unavailable: OPENAI_API_KEY=sk-123...cdef");
    expect(element.textContent).not.toContain("sk-1234567890abcdef");
    expect(element.textContent).toContain("Migrated 1, skipped 0");
  });
});
