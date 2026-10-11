import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../../lib/sessions/route-navigation.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { WorktreesModel } from "./worktrees-model.ts";
import { WorktreesView } from "./worktrees-page.tsx";

// mock-isolation: Replace the imperative dialog so confirmations remain deterministic.
vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

function worktree(id = "worktree-1"): WorktreeRecord {
  return {
    id,
    name: id,
    repoFingerprint: "0123456789abcdef",
    repoRoot: "/tmp/repo",
    path: `/tmp/repo/.worktrees/${id}`,
    branch: "main",
    baseRef: "main",
    ownerKind: "manual",
    createdAt: 1,
    lastActiveAt: 1,
  };
}

function gatewayWithSnapshot(client: GatewayBrowserClient | null, connected: boolean) {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
}

function gatewayWithClient(client: GatewayBrowserClient) {
  return gatewayWithSnapshot(client, true);
}

function mutableGateway(client: GatewayBrowserClient) {
  const snapshot = gatewayWithClient(client).snapshot;
  let listener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
  const gateway = {
    snapshot,
    subscribe(next: (snapshot: ApplicationGatewaySnapshot) => void) {
      listener = next;
      return () => {
        if (listener === next) {
          listener = undefined;
        }
      };
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    emit(connected: boolean) {
      (snapshot as ApplicationGatewaySnapshot).phase = connected ? "connected" : "stopped";
      listener?.(snapshot as ApplicationGatewaySnapshot);
    },
    setScopes(scopes: string[]) {
      snapshot.hello = {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes },
        features: { methods: ["worktrees.list", "worktrees.create"] },
      } as ApplicationGatewaySnapshot["hello"];
      listener?.(snapshot);
    },
    gateway,
  };
}

function contextWithGateway(gateway: ApplicationContext["gateway"]): ApplicationContext {
  return {
    basePath: "",
    gateway,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

const mountedPages = new Set<{ unmount(): void }>();

function createWorktreesPage(request?: ReturnType<typeof vi.fn>) {
  const [context, setContext] = createSignal(
    contextWithGateway(
      gatewayWithSnapshot(
        request ? ({ request } as unknown as GatewayBrowserClient) : null,
        Boolean(request),
      ),
    ),
  );
  const model = new WorktreesModel(context);
  const element = document.createElement("div");
  let dispose: (() => void) | undefined;
  const page = {
    model,
    element,
    setContext,
    mount() {
      flush();
      document.body.append(element);
      dispose = mountSolid(() => <WorktreesView model={model} />, { container: element }).unmount;
      mountedPages.add(page);
    },
    unmount() {
      dispose?.();
      dispose = undefined;
      element.remove();
      mountedPages.delete(page);
    },
  };
  return page;
}

function settle() {
  flush();
  return Promise.resolve();
}

function waitForList(request: ReturnType<typeof vi.fn>) {
  return waitForSolid(() =>
    expect(request).toHaveBeenCalledWith(
      "worktrees.list",
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
}

afterEach(() => {
  for (const page of mountedPages) {
    page.unmount();
  }
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("WorktreesPage lifecycle", () => {
  it("updates the shared header when the locale changes", async () => {
    const page = createWorktreesPage();
    page.mount();
    const locale = i18n.getLocale();
    try {
      await i18n.setLocale("pt-BR");
      flush();
      expect(i18n.t("tabs.sessions")).not.toBe("Sessions");
      expect(page.element.querySelector(".page-title")?.textContent).toBe(i18n.t("tabs.sessions"));
      expect(page.element.querySelector(".page-subtitle")?.textContent).toContain(
        i18n.t("subtitles.worktrees"),
      );
    } finally {
      await i18n.setLocale(locale);
    }
  });

  it("keeps read-only viewers in browsing mode without branch or mutation RPCs", async () => {
    const record = worktree();
    const request = vi.fn(async (method: string) =>
      method === "worktrees.list" ? { worktrees: [record] } : {},
    );
    const gateway = gatewayWithClient({ request } as unknown as GatewayBrowserClient);
    gateway.snapshot.hello = {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: {
        methods: ["worktrees.list", "worktrees.branches", "worktrees.remove", "worktrees.gc"],
      },
    } as ApplicationGatewaySnapshot["hello"];
    const page = createWorktreesPage();
    page.setContext(contextWithGateway(gateway));
    page.model.createRepoRoot = "/tmp/repo";
    page.mount();

    await waitForSolid(() => expect(page.model.records).toEqual([record]));
    await settle();
    expect(page.element.querySelector(".callout.info")?.textContent).toContain(
      "Worktree changes require operator.admin access.",
    );
    const mutationButtons = [...page.element.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) =>
        ["New worktree", "Clean up now", "Delete"].includes(button.textContent?.trim() ?? ""),
    );
    expect(mutationButtons).toHaveLength(3);
    expect(mutationButtons.every((button) => button.disabled)).toBe(true);

    await page.model.loadCreateBranches();
    await page.model.removeWorktree(record);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("worktrees.branches");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("worktrees.remove");
    expect(showConfirmDialog).not.toHaveBeenCalled();
  });

  it("closes an open create draft when admin access is lost", async () => {
    const request = vi.fn(async (method: string) =>
      method === "worktrees.list" ? { worktrees: [] } : {},
    );
    const source = mutableGateway({ request } as unknown as GatewayBrowserClient);
    const page = createWorktreesPage();
    page.setContext(contextWithGateway(source.gateway));
    page.model.createRepoRoot = "/tmp/repo";
    page.mount();

    await waitForList(request);
    await waitForSolid(() => expect(page.model.loading).toBe(false));
    const newWorktreeButton = [...page.element.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "New worktree",
    );
    expect(newWorktreeButton?.getAttribute("aria-expanded")).toBe("false");
    newWorktreeButton?.click();
    await settle();
    expect(page.element.querySelectorAll('input.settings-input[type="text"]')).toHaveLength(3);
    expect(newWorktreeButton?.getAttribute("aria-expanded")).toBe("true");

    source.setScopes(["operator.read"]);
    await settle();

    expect(page.model.createOpen).toBe(false);
    expect(page.element.querySelectorAll('input.settings-input[type="text"]')).toHaveLength(0);
    expect(newWorktreeButton?.disabled).toBe(true);
    expect(newWorktreeButton?.getAttribute("aria-expanded")).toBe("false");
    newWorktreeButton?.click();
    expect(request.mock.calls.map(([method]) => method)).not.toContain("worktrees.create");
  });

  it("navigates a session-owned worktree with the face-preference marker", async () => {
    // The owner key comes from a worktree record, not the cached session page, so its
    // face is a guess: the in-app click must carry the marker while href stays clean.
    const request = vi.fn(async (method: string) =>
      method === "worktrees.list"
        ? {
            worktrees: [
              {
                ...worktree(),
                ownerKind: "session" as const,
                ownerId: "agent:main:thread:12345678-90ab-cdef-1234-567890abcdef",
              },
            ],
          }
        : {},
    );
    const context = {
      ...contextWithGateway(gatewayWithClient({ request } as unknown as GatewayBrowserClient)),
      // No cached sessions: the owner key is only known to the worktree record.
      sessions: { state: { result: undefined } },
      agents: { state: { agentsList: { mainKey: "main" } } },
      agentSelection: { state: { selectedId: "main" } },
    } as unknown as ApplicationContext;
    const page = createWorktreesPage();
    page.setContext(context);
    page.mount();
    await waitForSolid(() => expect(page.model.records.length).toBe(1));
    await settle();

    const docsLink = page.element.querySelector<HTMLAnchorElement>(".page-subtitle a");
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(docsLink?.href).toBe("https://docs.openclaw.ai/concepts/managed-worktrees");

    const link = [...page.element.querySelectorAll("a")].find((anchor) =>
      anchor.getAttribute("href")?.includes("12345678"),
    );
    expect(link?.getAttribute("href")).toBe("/chat/main/1234567890abcdef1234567890abcdef");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(context.navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/1234567890abcdef1234567890abcdef",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
  });

  it("serializes list refreshes and row mutations", async () => {
    const record = worktree();
    const removedRecord = {
      ...record,
      removedAt: 2,
      snapshotRef: "refs/openclaw/worktree-snapshots/test",
    };
    const pendingList = deferred<{ worktrees: WorktreeRecord[] }>();
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.list") {
        listRequests += 1;
        if (listRequests === 1) {
          return Promise.resolve({ worktrees: [record] });
        }
        return listRequests === 2
          ? pendingList.promise
          : Promise.resolve({ worktrees: [removedRecord] });
      }
      return Promise.resolve({ removed: true });
    });
    const page = createWorktreesPage(request);
    page.mount();
    await waitForSolid(() => expect(page.model.records).toEqual([record]));
    await waitForSolid(() => expect(page.model.loading).toBe(false));

    const refreshing = page.model.load();
    await waitForSolid(() => expect(listRequests).toBe(2));
    await settle();

    const deleteButton = page.element.querySelector<HTMLButtonElement>("button.danger");
    expect(deleteButton?.disabled).toBe(true);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await page.model.removeWorktree(record);
    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalledWith("worktrees.remove", { id: record.id });

    pendingList.resolve({ worktrees: [record] });
    await refreshing;

    await page.model.removeWorktree(record);
    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("worktrees.remove", { id: record.id });
    expect(listRequests).toBe(3);
    expect(page.model.records).toEqual([removedRecord]);
  });

  it("clears stale records when a null-client gateway source is replaced", async () => {
    const page = createWorktreesPage();
    page.model.records = [worktree("stale")];
    page.setContext(contextWithGateway(gatewayWithSnapshot(null, false)));
    page.mount();
    await settle();
    expect(page.model.records).toHaveLength(1);

    page.setContext(contextWithGateway(gatewayWithSnapshot(null, false)));
    await settle();

    expect(page.model.records).toEqual([]);
  });

  it("starts a replacement-client load after disconnecting during an in-flight load", async () => {
    const first = deferred<{ worktrees: [] }>();
    const firstRequest = vi.fn(() => first.promise);
    const secondRequest = vi.fn(async () => ({ worktrees: [] }));
    const page = createWorktreesPage();
    page.setContext(
      contextWithGateway(
        gatewayWithClient({ request: firstRequest } as unknown as GatewayBrowserClient),
      ),
    );

    page.mount();
    await waitForSolid(() => expect(firstRequest).toHaveBeenCalledOnce());
    expect(page.model.loading).toBe(true);

    page.unmount();
    page.setContext(
      contextWithGateway(
        gatewayWithClient({ request: secondRequest } as unknown as GatewayBrowserClient),
      ),
    );
    page.mount();

    await waitForSolid(() => expect(secondRequest).toHaveBeenCalledOnce());
    await waitForSolid(() => expect(page.model.loading).toBe(false));

    first.resolve({ worktrees: [] });
    await Promise.resolve();
    expect(page.model.loading).toBe(false);
  });

  it("never force-removes through a replacement gateway", async () => {
    const pendingRemove = deferred<unknown>();
    const firstRequest = vi.fn((method: string) => {
      if (method === "worktrees.remove") {
        return pendingRemove.promise;
      }
      return Promise.resolve({ worktrees: [] });
    });
    const secondRequest = vi.fn(async () => ({ worktrees: [] }));
    const page = createWorktreesPage();
    page.setContext(
      contextWithGateway(
        gatewayWithClient({ request: firstRequest } as unknown as GatewayBrowserClient),
      ),
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    page.mount();
    await waitForList(firstRequest);

    const removing = page.model.removeWorktree(worktree());
    await waitForSolid(() =>
      expect(firstRequest).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" }),
    );

    page.setContext(
      contextWithGateway(
        gatewayWithClient({ request: secondRequest } as unknown as GatewayBrowserClient),
      ),
    );
    await settle();
    pendingRemove.reject(new Error("snapshot failed: stale gateway"));
    await removing;

    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(secondRequest).not.toHaveBeenCalledWith("worktrees.remove", {
      id: "worktree-1",
      force: true,
    });
    expect(page.model.error).toBeNull();
    expect(page.model.operation).toBeNull();
  });

  it("does not remove through a replacement gateway after confirmation", async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const firstRequest = vi.fn(async () => ({ worktrees: [] }));
    const secondRequest = vi.fn(async () => ({ worktrees: [] }));
    const page = createWorktreesPage();
    page.setContext(
      contextWithGateway(
        gatewayWithClient({ request: firstRequest } as unknown as GatewayBrowserClient),
      ),
    );
    page.mount();
    await waitForSolid(() => expect(firstRequest).toHaveBeenCalledOnce());

    const removing = page.model.removeWorktree(worktree());
    await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    page.setContext(
      contextWithGateway(
        gatewayWithClient({ request: secondRequest } as unknown as GatewayBrowserClient),
      ),
    );
    await settle();
    confirmation.resolve(true);
    await removing;

    expect(firstRequest).not.toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" });
    expect(secondRequest).not.toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" });
  });

  it("does not remove after admin access is lost during confirmation", async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const request = vi.fn(async (method: string) =>
      method === "worktrees.list" ? { worktrees: [] } : {},
    );
    const source = mutableGateway({ request } as unknown as GatewayBrowserClient);
    const page = createWorktreesPage();
    page.setContext(contextWithGateway(source.gateway));
    page.mount();
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());

    const removing = page.model.removeWorktree(worktree());
    await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    source.setScopes(["operator.read"]);
    confirmation.resolve(true);
    await removing;

    expect(request).not.toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" });
  });

  it("does not force-remove after admin access is lost during confirmation", async () => {
    const forceConfirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog)
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(forceConfirmation.promise);
    const request = vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "worktrees.remove" && !params?.force) {
        return Promise.resolve({ removed: false, snapshotError: "nested gitlink" });
      }
      return Promise.resolve({ worktrees: [] });
    });
    const source = mutableGateway({ request } as unknown as GatewayBrowserClient);
    const page = createWorktreesPage();
    page.setContext(contextWithGateway(source.gateway));
    page.mount();
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());

    const removing = page.model.removeWorktree(worktree());
    await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledTimes(2));
    source.setScopes(["operator.read"]);
    forceConfirmation.resolve(true);
    await removing;

    expect(request).not.toHaveBeenCalledWith("worktrees.remove", {
      id: "worktree-1",
      force: true,
    });
  });

  it("surfaces the snapshot failure after a forced removal", async () => {
    const request = vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "worktrees.remove") {
        return params?.force
          ? Promise.resolve({ removed: true, snapshotError: "nested gitlink" })
          : Promise.resolve({ removed: false, snapshotError: "nested gitlink" });
      }
      return Promise.resolve({ worktrees: [] });
    });
    const page = createWorktreesPage(request);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    page.mount();
    await waitForList(request);

    await page.model.removeWorktree(worktree());

    expect(request).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" });
    expect(request).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1", force: true });
    expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    expect(page.model.error).toBe("nested gitlink");
    await settle();
    expect(page.element.querySelector(".callout.danger")?.textContent).toContain("nested gitlink");
  });

  it("discards a restore error across a same-client reconnect", async () => {
    const pendingRestore = deferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "worktrees.restore") {
        return pendingRestore.promise;
      }
      return Promise.resolve({ worktrees: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const source = mutableGateway(client);
    const page = createWorktreesPage();
    page.setContext(contextWithGateway(source.gateway));
    page.mount();
    await waitForList(request);

    const restoring = page.model.restore(worktree());
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("worktrees.restore", { id: "worktree-1" }),
    );
    source.emit(false);
    source.emit(true);
    pendingRestore.reject(new Error("stale restore error"));
    await restoring;

    expect(page.model.error).toBeNull();
    expect(page.model.operation).toBeNull();
  });

  it("keeps a restore error after the reconciliation refresh succeeds", async () => {
    const record = worktree();
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.list") {
        listRequests += 1;
        return Promise.resolve({ worktrees: [record] });
      }
      if (method === "worktrees.restore") {
        return Promise.reject(new Error("restore failed: OPENAI_API_KEY=sk-1234567890abcdef"));
      }
      return Promise.resolve({});
    });
    const page = createWorktreesPage(request);
    page.mount();
    await waitForSolid(() => expect(listRequests).toBe(1));
    await waitForSolid(() => expect(page.model.loading).toBe(false));

    await page.model.restore(record);

    expect(listRequests).toBe(2);
    expect(page.model.error).toBe("restore failed: OPENAI_API_KEY=sk-123...cdef");
    expect(page.model.operation).toBeNull();
  });

  it("replaces a mutation error when the reconciliation refresh also fails", async () => {
    const record = worktree();
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.list") {
        listRequests += 1;
        return listRequests === 1
          ? Promise.resolve({ worktrees: [record] })
          : Promise.reject(new Error("list failed"));
      }
      if (method === "worktrees.restore") {
        return Promise.reject(new Error("restore failed"));
      }
      return Promise.resolve({});
    });
    const page = createWorktreesPage(request);
    page.mount();
    await waitForSolid(() => expect(listRequests).toBe(1));
    await waitForSolid(() => expect(page.model.loading).toBe(false));

    await page.model.restore(record);

    expect(listRequests).toBe(2);
    expect(page.model.error).toBe("list failed");
    expect(page.model.operation).toBeNull();
  });

  it("surfaces an operation failure after an earlier list failure", async () => {
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.list") {
        listRequests += 1;
        return listRequests === 1
          ? Promise.reject(new Error("stale list failure"))
          : Promise.resolve({ worktrees: [] });
      }
      if (method === "worktrees.restore") {
        return Promise.reject(new Error("restore failed"));
      }
      return Promise.resolve({});
    });
    const page = createWorktreesPage(request);
    page.mount();
    await waitForSolid(() => expect(page.model.error).toBe("stale list failure"));

    await page.model.restore(worktree());

    expect(page.model.error).toBe("restore failed");
  });

  it("clears pending create state across a same-client reconnect", async () => {
    const pendingCreate = deferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "worktrees.create") {
        return pendingCreate.promise;
      }
      return Promise.resolve({ worktrees: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const source = mutableGateway(client);
    const page = createWorktreesPage();
    page.setContext(contextWithGateway(source.gateway));
    page.model.createRepoRoot = "/tmp/repo";
    page.mount();
    await waitForList(request);

    const creating = page.model.createWorktree();
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("worktrees.create", { repoRoot: "/tmp/repo" }),
    );
    expect(page.model.operation).toBe("create");

    source.emit(false);
    source.emit(true);
    expect(page.model.operation === "create").toBe(false);

    pendingCreate.reject(new Error("gateway closed"));
    await creating;
    expect(page.model.operation === "create").toBe(false);
    expect(page.model.error).toBeNull();
  });

  it("clears GC loading across a same-client reconnect", async () => {
    const pendingGc = deferred<unknown>();
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.gc") {
        return pendingGc.promise;
      }
      listRequests += 1;
      return Promise.resolve({ worktrees: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const source = mutableGateway(client);
    const page = createWorktreesPage();
    page.setContext(contextWithGateway(source.gateway));
    page.mount();
    await waitForSolid(() => expect(listRequests).toBe(1));

    const collecting = page.model.gc();
    await waitForSolid(() => expect(request).toHaveBeenCalledWith("worktrees.gc", {}));
    expect(page.model.loading).toBe(true);
    source.emit(false);
    source.emit(true);

    await waitForSolid(() => expect(listRequests).toBe(2));
    await waitForSolid(() => expect(page.model.loading).toBe(false));
    pendingGc.resolve({});
    await collecting;
    expect(page.model.loading).toBe(false);
  });

  it("keeps an in-progress repository draft when the list refresh completes", async () => {
    const pendingList = deferred<unknown>();
    const request = vi.fn((method: string) =>
      method === "worktrees.list" ? pendingList.promise : Promise.resolve({ branches: [] }),
    );
    const page = createWorktreesPage(request);
    page.model.createOpen = true;
    page.mount();
    await waitForList(request);

    const repository = page.element.querySelector<HTMLInputElement>(
      'input[aria-label="Repository"]',
    )!;
    repository.value = "/tmp/new-repo";
    repository.dispatchEvent(new Event("input", { bubbles: true }));
    pendingList.resolve({ worktrees: [] });
    await waitForSolid(() => expect(page.model.loading).toBe(false));

    expect(repository.value).toBe("/tmp/new-repo");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("worktrees.branches");
    repository.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "worktrees.branches",
        { repoRoot: "/tmp/new-repo" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("locks the create draft and its toggle until create settles", async () => {
    const pendingCreate = deferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "worktrees.create") {
        return pendingCreate.promise;
      }
      return Promise.resolve({ worktrees: [] });
    });
    const page = createWorktreesPage(request);
    page.model.createOpen = true;
    page.model.createRepoRoot = "/tmp/repo";
    page.model.createName = "submitted-name";
    page.model.createBaseRef = "main";
    page.mount();
    await waitForList(request);
    await waitForSolid(() => expect(page.model.loading).toBe(false));

    const toggleButton = Array.from(
      page.element.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "New worktree");
    const creating = page.model.createWorktree();
    toggleButton?.click();
    expect(page.model.createOpen).toBe(true);
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("worktrees.create", {
        baseRef: "main",
        name: "submitted-name",
        repoRoot: "/tmp/repo",
      }),
    );
    await settle();

    const draftInputs = Array.from(
      page.element.querySelectorAll<HTMLInputElement>('input.settings-input[type="text"]'),
    );
    const createButton = page.element.querySelector<HTMLButtonElement>(
      ".settings-group .settings-row button.btn--sm",
    );
    expect(draftInputs).toHaveLength(3);
    expect(draftInputs.every((input) => input.disabled)).toBe(true);
    expect(createButton?.disabled).toBe(true);
    expect(toggleButton?.disabled).toBe(true);

    toggleButton?.click();
    expect(page.model.createOpen).toBe(true);

    pendingCreate.resolve({});
    await creating;
    await settle();
    expect(page.model.createOpen).toBe(false);
    expect(toggleButton?.disabled).toBe(false);

    toggleButton?.click();
    await settle();
    const freshInputs = Array.from(
      page.element.querySelectorAll<HTMLInputElement>('input.settings-input[type="text"]'),
    );
    expect(freshInputs).toHaveLength(3);
    expect(freshInputs.every((input) => !input.disabled)).toBe(true);
  });

  it.each([undefined, "main"])(
    "leaves base resolution to the Gateway (remote default: %s)",
    async (defaultBranch) => {
      const request = vi.fn((method: string) => {
        if (method === "worktrees.branches") {
          return Promise.resolve({
            branches: [{ name: "main" }],
            headBranch: "main",
            defaultBranch,
          });
        }
        return Promise.resolve({ worktrees: [] });
      });
      const page = createWorktreesPage();
      page.setContext(
        contextWithGateway(gatewayWithClient({ request } as unknown as GatewayBrowserClient)),
      );
      page.model.createRepoRoot = "/tmp/repo";
      page.mount();
      await waitForSolid(() =>
        expect(request).toHaveBeenCalledWith(
          "worktrees.list",
          {},
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );

      await page.model.loadCreateBranches();

      await waitForSolid(() => expect(page.model.createBranches).toEqual(["main"]));
      expect(page.model.createBaseRef).toBe("");
      await page.model.createWorktree();
      expect(request).toHaveBeenCalledWith("worktrees.create", { repoRoot: "/tmp/repo" });
    },
  );

  it("ignores a stale branch failure after a newer request succeeds", async () => {
    const firstBranches = deferred<unknown>();
    let branchRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.branches") {
        branchRequests += 1;
        return branchRequests === 1
          ? firstBranches.promise
          : Promise.resolve({ branches: [{ name: "main" }], headBranch: "main" });
      }
      return Promise.resolve({ worktrees: [] });
    });
    const page = createWorktreesPage(request);
    page.model.createRepoRoot = "/tmp/repo";
    page.model.createBaseRef = "release";
    page.mount();
    await waitForList(request);

    void page.model.loadCreateBranches();
    void page.model.loadCreateBranches();
    await waitForSolid(() => expect(page.model.createBranches).toEqual(["main"]));
    expect(page.model.createBaseRef).toBe("release");

    firstBranches.reject(new Error("stale branch failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(page.model.createBranches).toEqual(["main"]);
    expect(page.model.createBaseRef).toBe("release");
  });
});
