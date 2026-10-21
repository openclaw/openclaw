/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createComponent, createSignal, flush } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerListener } from "../../../../../src/shared/listeners.ts";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import { ShellLayoutOwner } from "../../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../../app/shell-layout-traits-solid.tsx";
import { showConfirmDialog } from "../../../components/confirm-dialog.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createAgentMemory, type AgentMemoryState } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";
import { AgentMemoryPanel } from "./memory-panel.tsx";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";

vi.mock("../../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
const restoreTranslations = installDreamingViewTestTranslations();
afterAll(() => restoreTranslations());
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

function contextWithRequest(request: Parameters<typeof createTestGatewayClient>[0]) {
  const { gateway, publish } = createApplicationGateway();
  publish({
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: gatewayHelloForMethods(["config.patch"]),
    sessionKey: "main",
  });
  const configListeners = new Set<() => void>();
  const context = {
    gateway,
    agents: { state: { agentsList: null }, subscribe: () => () => {} },
    runtimeConfig: {
      state: { configForm: null, configSnapshot: null },
      ensureLoaded: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      subscribe: (listener: () => void) => registerListener(configListeners, listener),
    },
  } as unknown as ApplicationContext;
  return Object.assign(context, {
    emit(patch: Partial<ApplicationGatewaySnapshot>) {
      publish({ ...gateway.snapshot, ...patch });
    },
    setConfig(config: Record<string, unknown>) {
      context.runtimeConfig.state.configForm = config;
      context.runtimeConfig.state.configSnapshot = { config };
      configListeners.forEach((listener) => listener());
    },
  });
}

const STATUS = "doctor.memory.status";
const DIARY = "doctor.memory.dreamDiary";
const REPAIR = "doctor.memory.repairDreamingArtifacts";
const PREVIEW = ".dreams-diary__preview-panel";
const PREVIEW_TEXT = ".dreams-diary__preview-pre";

function requestFor(
  replies: Record<string, () => unknown>,
  fallback: (method: string) => unknown = emptyReply,
) {
  return vi.fn((method: string) => replies[method]?.() ?? fallback(method));
}

function memoryStatus(promotedToday: number, extra: Record<string, unknown> = {}) {
  return { dreaming: { enabled: true, promotedToday, ...extra } };
}

function diary(content: string) {
  return { found: true, path: "DREAMS.md", content };
}

const emptyClient = () => createTestGatewayClient(vi.fn(emptyReply));

const emptyReply = (method: string) =>
  method === STATUS ? { dreaming: null } : { found: false, path: "DREAMS.md" };
function createAgentTarget(initialAgentId: string | null) {
  let agentId = initialAgentId;
  const listeners = new Set<() => void>();
  return {
    read: () => agentId,
    subscribe: (notify: () => void) => registerListener(listeners, notify),
    set: (next: string | null) => {
      agentId = next;
      listeners.forEach((notify) => notify());
    },
    subscriberCount: () => listeners.size,
  };
}

async function createPage(
  replies:
    | Parameters<typeof createTestGatewayClient>[0]
    | Record<string, () => unknown> = emptyReply,
  agentId = "main",
  hello = gatewayHelloForMethods(["config.patch"]),
) {
  const request = typeof replies === "function" ? vi.fn(replies) : requestFor(replies);
  const context = contextWithRequest(request);
  context.emit({ hello });
  const agentTarget = createAgentTarget(agentId);
  let state: AgentMemoryState;
  const { container, unmount } = mountSolid(() => {
    state = createAgentMemory(context, () => agentTarget);
    return AgentMemoryView({ state });
  });
  await waitForSolid(() => expect(state.view().header.refreshLoading).toBe(false));
  return {
    get state() {
      return state;
    },
    context,
    request,
    get dreaming() {
      return state.view().dreaming;
    },
    get toggle() {
      return state.view().toggle;
    },
    query: container.querySelector.bind(container),
    text: (selector: string) => container.querySelector(selector)?.textContent,
    waitText: (selector: string, text: string) =>
      waitForSolid(() => expect(container.querySelector(selector)?.textContent).toBe(text)),
    container,
    setAgentId: agentTarget.set,
    unmount,
  };
}

function click(container: HTMLElement, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
  flush();
}

function wikiOverview(title = "Original title") {
  return {
    totalItems: 1,
    totalPages: 1,
    pageCounts: { synthesis: 1 },
    clusters: [
      {
        key: "synthesis",
        label: "Syntheses",
        itemCount: 1,
        items: [
          {
            pagePath: "syntheses/example.md",
            title,
            kind: "synthesis",
            claims: [],
            questions: [],
            contradictions: [],
          },
        ],
      },
    ],
  };
}

it("scopes native memory requests to the current agent and releases shell layout", async () => {
  const request = vi.fn(emptyReply);
  const context = contextWithRequest(request);
  const unsubscribe = vi.fn();
  context.gateway.subscribe = () => unsubscribe;
  const content = document.createElement("main");
  content.className = "content";
  document.body.append(content);
  const owner = new ShellLayoutOwner();
  owner.contentRef(content);
  const provider = createSolidApplicationContextProvider(context);
  const originalTarget = createAgentTarget("main");
  const getInitialTarget = vi.fn(() => agentTarget());
  const replacementTarget = createAgentTarget("ignored");
  const [agentTarget, setAgentTarget] = createSignal(originalTarget);
  const view = mountSolid(
    () => {
      const panel = createComponent(ShellLayoutProvider, {
        value: { owner, host: content },
        get children() {
          return createComponent(AgentMemoryPanel, {
            get initialAgentTarget() {
              return getInitialTarget();
            },
          });
        },
      });
      expect(getInitialTarget).not.toHaveBeenCalled();
      originalTarget.set("support");
      return panel;
    },
    { container: content, wrapper: provider.wrapper },
  );
  await waitForSolid(() => expect(request).toHaveBeenCalledWith(STATUS, { agentId: "support" }));
  expect(getInitialTarget).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(DIARY, { agentId: "support" });
  const host = content.querySelector<HTMLElement>("openclaw-agent-memory-panel")!;
  expect(host.querySelector(".agent-memory-panel__header")).not.toBeNull();
  expect(owner.current.toolbarHeader).toBe(true);

  click(host, "#dreams-tab-diary");
  expect(originalTarget.subscriberCount()).toBe(1);
  setAgentTarget(replacementTarget);
  flush();
  expect(replacementTarget.subscriberCount()).toBe(0);
  originalTarget.set(" support ");
  expect(request).toHaveBeenCalledTimes(2);

  originalTarget.set("main");
  await waitForSolid(() => expect(request).toHaveBeenCalledWith(STATUS, { agentId: "main" }));
  expect(content.querySelector("openclaw-agent-memory-panel")).toBe(host);
  expect(host.querySelector("#dreams-tab-diary")?.getAttribute("aria-selected")).toBe("true");
  view.unmount();
  expect(originalTarget.subscriberCount()).toBe(0);
  expect(owner.current.toolbarHeader).toBeUndefined();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("waits for a committed agent before loading agent-scoped memory", async () => {
  const page = await createPage(undefined, "");
  await page.dreaming.onOpenWikiPage("unowned.md");
  expect(page.request).not.toHaveBeenCalled();
  page.setAgentId("support");
  await waitForSolid(() => expect(page.request).toHaveBeenCalledTimes(2));
  expect(page.request).toHaveBeenCalledWith(STATUS, { agentId: "support" });
  expect(page.request).toHaveBeenCalledWith(DIARY, { agentId: "support" });
});

it.each([false, true])("scopes confirmed actions (agent changed: %s)", async (changed) => {
  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
  const page = await createPage(
    undefined,
    "main",
    gatewayHelloForMethods([REPAIR], ["operator.write"]),
  );
  page.dreaming.onRepairDreamingArtifacts();
  expect(showConfirmDialog).toHaveBeenCalledOnce();
  if (changed) {
    page.setAgentId("support");
  }
  confirmation.resolve(true);
  await waitForSolid(() => expect(page.dreaming.dreamDiaryActionLoading).toBe(false));
  await waitForSolid(() =>
    expect(page.request.mock.calls.filter(([method]) => method === REPAIR)).toEqual(
      changed ? [] : [[REPAIR, { agentId: "main" }]],
    ),
  );
});

it.each(["", "main"])(
  "resets stale panel data after switching through support to %s",
  async (agentId) => {
    const reply = deferred<unknown>();
    const request = vi.fn((method: string, params?: unknown) =>
      method === DIARY
        ? asOptionalRecord(params)?.agentId === "main"
          ? Promise.resolve(diary("main-only"))
          : reply.promise
        : Promise.resolve(emptyReply(method)),
    );
    const page = await createPage(request);
    await waitForSolid(() => expect(page.dreaming.dreamDiaryContent).toBe("main-only"));
    page.setAgentId("support");
    expect(page.dreaming).toMatchObject({ selectedAgentId: "support", dreamDiaryContent: null });
    await waitForSolid(() => expect(request).toHaveBeenCalledWith(DIARY, { agentId: "support" }));
    page.setAgentId(agentId);
    await waitForSolid(() => expect(page.dreaming.selectedAgentId).toBe(agentId));
    if (agentId) {
      await waitForSolid(() => expect(page.dreaming.dreamDiaryContent).toBe("main-only"));
    }
    reply.resolve(diary("support-only"));
    await reply.promise;
    flush();
    expect(page.dreaming.dreamDiaryContent).toBe(agentId ? "main-only" : null);
  },
);

it.each([false, true])(
  "preserves interrupted action outcomes (confirmed: %s)",
  async (confirmed) => {
    const action = deferred<unknown>();
    const refresh = deferred<unknown>();
    let statusReads = 0;
    const request = vi.fn((name: string) => {
      if (name === REPAIR) {
        return action.promise;
      }
      if (name === STATUS && ++statusReads === 2) {
        return refresh.promise;
      }
      return Promise.resolve(emptyReply(name));
    });
    const hello = gatewayHelloForMethods([REPAIR], ["operator.read", "operator.write"]);
    const page = await createPage(request, "main", hello);
    const { context } = page;
    click(page.container, "#dreams-tab-advanced");
    vi.mocked(showConfirmDialog).mockResolvedValueOnce(true);
    page.dreaming.onRepairDreamingArtifacts();
    await waitForSolid(() => expect(request).toHaveBeenCalledWith(REPAIR, { agentId: "main" }));
    const result = { archivedDreamsDiary: true, archiveDir: "/tmp/dreaming-repair" };
    if (confirmed) {
      action.resolve(result);
      await waitForSolid(() => expect(statusReads).toBe(2));
    }

    context.emit({ phase: "reconnecting", hello: null });
    flush();
    const message = confirmed
      ? "Dream cache repair complete"
      : "Connection lost before the memory action was confirmed. It may have completed.";
    expect(page.text("[role='status']")).toContain(message);
    expect(page.dreaming).toMatchObject({
      dreamDiaryActionLoading: false,
      access: { canRepairDreamingArtifacts: false },
    });

    context.emit({ phase: "connected", hello });
    action.resolve(result);
    refresh.resolve(emptyReply(STATUS));
    await waitForSolid(() => expect(statusReads).toBe(confirmed ? 3 : 2));
    await waitForSolid(() => expect(page.state.view().header.refreshLoading).toBe(false));
    expect(page.text("[role='status']")).toContain(message);
    expect(request.mock.calls.filter(([method]) => method === REPAIR)).toHaveLength(1);
    expect(page.dreaming.dreamDiaryActionArchivePath).toBe(
      confirmed ? "/tmp/dreaming-repair" : null,
    );

    context.emit({ client: emptyClient() });
    flush();
    expect(page.dreaming).toMatchObject({
      dreamDiaryActionMessage: null,
      dreamDiaryActionArchivePath: null,
    });
  },
);

it("retains diary, preview and toggle drafts through reconnect while rejecting old reads", async () => {
  const stale = deferred<unknown>();
  let refresh = false;
  const fresh = deferred<unknown>();
  const freshPreview = deferred<unknown>();
  const page = await createPage({
    [DIARY]: () => (refresh ? fresh.promise : diary("Retained diary")),
    "wiki.get": () => (refresh ? freshPreview.promise : stale.promise),
  });
  const { context } = page;
  const hello = context.gateway.snapshot.hello;
  await waitForSolid(() => expect(page.dreaming.dreamDiaryContent).toBe("Retained diary"));
  click(page.container, "#dreams-tab-diary");
  const preview = page.dreaming.onOpenWikiPage("retained.md");
  page.state.setEnabled(false);
  flush();
  const previewDialog = page.query(PREVIEW);
  expect(previewDialog).not.toBeNull();
  context.emit({ phase: "reconnecting", hello: null });
  flush();
  expect(page.dreaming).toMatchObject({
    dreamDiaryContent: "Retained diary",
    wikiPreview: { page: { path: "retained.md" }, loading: true },
  });
  expect(page.toggle).toMatchObject({ open: true, disabled: true });
  expect(page.query<HTMLButtonElement>(".exec-approval-actions button")?.disabled).toBe(true);
  refresh = true;
  context.emit({ phase: "connected", hello });
  await waitForSolid(() =>
    expect(page.request.mock.calls.filter(([method]) => method === DIARY)).toHaveLength(2),
  );
  expect(page.dreaming.dreamDiaryContent).toBe("Retained diary");
  expect(page.request.mock.calls.filter(([method]) => method === "wiki.get")).toHaveLength(2);
  stale.resolve({ title: "Old", path: "retained.md", content: "Stale preview" });
  await preview;
  expect(page.dreaming.wikiPreview).toMatchObject({ page: { content: "" }, loading: true });
  expect(page.toggle.open).toBe(true);
  freshPreview.resolve({ title: "Fresh", path: "retained.md", content: "Fresh preview" });
  await page.waitText(PREVIEW_TEXT, "Fresh preview");
  expect(page.query(PREVIEW)).toBe(previewDialog);
  fresh.resolve(diary("Fresh diary"));
  await waitForSolid(() => expect(page.dreaming.dreamDiaryContent).toBe("Fresh diary"));

  context.emit({ client: emptyClient() });
  flush();
  expect(page.state.view()).toMatchObject({
    dreaming: { dreamDiaryContent: null, wikiPreview: null },
    toggle: { open: false },
  });
});

it.each(["agent", "client", "access", "unmount"] as const)(
  "retires pending wiki requests and modal state on %s replacement",
  async (replacement) => {
    const pending = deferred<unknown>();
    const page = await createPage({ "wiki.get": () => pending.promise }, "support");
    const { context } = page;
    click(page.container, "#dreams-tab-diary");
    const preview = page.dreaming.onOpenWikiPage("support.md");
    page.state.setEnabled(false);
    await waitForSolid(() => expect(page.query(PREVIEW)).not.toBeNull());
    expect(page.toggle.open).toBe(true);
    if (replacement === "agent") {
      page.setAgentId("marketing");
    } else if (replacement === "client") {
      context.emit({ client: emptyClient() });
    } else if (replacement === "access") {
      context.emit({ hello: gatewayHelloForMethods([], []) });
    } else {
      page.unmount();
    }
    pending.resolve({ title: "Support", path: "support.md", content: "stale" });
    await preview;
    flush();
    expect(page.query(PREVIEW)).toBeNull();
    expect(page.query("openclaw-modal-dialog")).toBeNull();
    if (replacement !== "unmount") {
      expect(page.toggle.open).toBe(false);
      expect(page.dreaming.wikiPreview).toBeNull();
    }
  },
);

it.each(["support-only", ""])("loads scoped wiki preview content %j", async (content) => {
  const response = deferred<unknown>();
  const page = await createPage({ "wiki.get": () => response.promise }, "support");
  click(page.container, "#dreams-tab-diary");
  const pending = page.dreaming.onOpenWikiPage("support.md");
  flush();
  const dialog = page.query("openclaw-modal-dialog");
  expect(dialog).not.toBeNull();
  expect(page.request).toHaveBeenCalledWith("wiki.get", {
    lookup: "support.md",
    fromLine: 1,
    lineCount: 5000,
    agentId: "support",
  });
  response.resolve({ content, totalLines: 6001, truncated: true });
  await pending;
  const expected = content || "No wiki content available.";
  expect(page.dreaming.wikiPreview?.page.content).toBe(expected);
  await page.waitText(PREVIEW_TEXT, expected);
  expect(page.query("openclaw-modal-dialog")).toBe(dialog);
  expect(page.text(".dreams-diary__preview-hint")).toContain("6001");
  click(page.container, ".dreams-diary__preview-footer button");
  expect(page.dreaming.wikiPreview).toBeNull();
});

it("updates the mounted view across tab selection and owner notifications", async () => {
  let promotedToday = 2;
  let title = "Original title";
  const page = await createPage(
    requestFor(
      {
        [STATUS]: () =>
          memoryStatus(promotedToday, {
            phases: { light: { enabled: true }, deep: { enabled: false }, rem: { enabled: false } },
          }),
        [DIARY]: () => diary("*April 4, 2026*\nFirst dream.\n---\n*April 5, 2026*\nSecond dream."),
        "wiki.overview": () => wikiOverview(title),
      },
      () => ({ clusters: [], totalItems: 0 }),
    ),
  );
  const { context } = page;
  const scene = page.query(".dreams");
  promotedToday = 9;
  await page.state.loadResources();
  await waitForSolid(() => expect(page.text(".dreams__status-detail")).toContain("9 promoted"));
  expect(page.query(".dreams")).toBe(scene);
  expect(page.container.querySelectorAll(".dreams__phase--off")).toHaveLength(2);
  click(page.container, "#dreams-tab-diary");
  const dayChip = page.container.querySelectorAll<HTMLButtonElement>(".dreams-diary__day-chip")[1]!;
  dayChip.focus();
  dayChip.click();
  flush();
  await page.state.loadResources();
  flush();
  expect(page.container.querySelectorAll(".dreams-diary__day-chip")[1]).toBe(dayChip);
  expect(document.activeElement).toBe(dayChip);
  expect(dayChip.classList.contains("dreams-diary__day-chip--active")).toBe(true);
  click(page.container, "#dream-diary-tab-insights");
  expect(page.text("#dream-diary-panel")).toContain("memory-wiki");
  expect(page.query("#dream-diary-panel")?.getAttribute("aria-labelledby")).toBe(
    "dream-diary-tab-insights",
  );
  context.setConfig({ plugins: { entries: { "memory-wiki": { enabled: true } } } });
  context.emit({
    hello: gatewayHelloForMethods(["config.patch", "wiki.overview", "wiki.importInsights"]),
  });
  await page.state.loadResources("wikiOverview");
  click(page.container, "#dream-diary-tab-wiki");
  const card = page.query("[data-wiki-page]")!;
  const details = card.querySelector<HTMLButtonElement>("button")!;
  details.focus();
  details.click();
  flush();
  title = "Refreshed title";
  await page.state.loadResources("wikiOverview");
  await waitForSolid(() =>
    expect(card.querySelector(".dreams-diary__insight-title")?.textContent).toBe(title),
  );
  expect(page.query("[data-wiki-page]")).toBe(card);
  expect(card.querySelector("button")).toBe(details);
  expect(document.activeElement).toBe(details);
});

it.each([false, true])(
  "hides cached runtime when engine is Off (override: %s)",
  async (override) => {
    const page = await createPage({
      [STATUS]: () =>
        memoryStatus(7, {
          timezone: "Mars/Base",
          phases: { light: { enabled: true }, deep: { enabled: true }, rem: { enabled: true } },
        }),
    });
    const { context } = page;
    await waitForSolid(() => expect(page.container.textContent).toContain("7 promoted"));
    const plugins: Record<string, unknown> = { slots: { memory: "none" } };
    if (override) {
      plugins.entries = { "memory-core": { config: { dreaming: { enabled: false } } } };
    }
    context.setConfig({ plugins });
    await waitForSolid(() => expect(page.container.textContent).toContain("Memory engine is Off"));
    const toggle = page.query<HTMLButtonElement>(".dreams__phase-toggle")!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.classList.contains("dreams__phase-toggle--on")).toBe(false);
    expect(page.container.textContent).not.toContain("Using default: Enabled");
    expect(page.container.textContent).toContain("0 promoted");
    expect(page.container.textContent).not.toContain("7 promoted");
    expect(page.container.textContent).not.toContain("Mars/Base");
    toggle.click();
    expect(page.toggle.open).toBe(false);
  },
);

describe.runIf(process.env.OPENCLAW_UI_MEMORY_CHROMIUM_E2E === "1")(
  "agent memory real Chromium owner proof",
  () => {
    let browser: import("playwright").Browser;
    let server: import("../../../test-helpers/control-ui-e2e.ts").ControlUiE2eServer;
    let e2e: typeof import("../../../test-helpers/control-ui-e2e.ts");

    beforeAll(async () => {
      const { chromium } = await import("playwright");
      e2e = await import("../../../test-helpers/control-ui-e2e.ts");
      const executablePath = e2e.resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
      if (!e2e.canRunPlaywrightChromium(executablePath)) {
        throw new Error(`Real Chromium required but unavailable: ${executablePath}`);
      }
      server = await e2e.startControlUiE2eServer();
      browser = await chromium.launch({ executablePath, headless: true });
    }, 90_000);

    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    it("preserves both routes, agent ownership, wiki gating, and reconnects", async () => {
      const status = (agentId: string, promotedToday: number) => ({
        agentId,
        ...memoryStatus(promotedToday),
      });
      const agentDiary = (agentId: string) => ({
        agentId,
        ...diary(`*April 5, 2026*\n${agentId} owns this dream.`),
      });
      const scoped = (responses: Record<string, unknown>) => ({
        cases: Object.entries(responses).map(([agentId, response]) => ({
          match: { agentId },
          response,
        })),
      });
      const statusCases = (count: number) =>
        scoped({ main: status("main", count), support: status("support", 22) });
      const roster = {
        agents: [
          { id: "main", name: "Main" },
          { id: "support", name: "Support" },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      };
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const gateway = await e2e.installMockGateway(page, {
        webSocketPassthroughPrefixes: [`${e2e.controlUiBundledGatewayUrl(server.baseUrl)}/?token=`],
        featureMethods: ["chat.metadata", "chat.startup", STATUS, DIARY],
        methodResponses: {
          "agents.list": roster,
          "config.get": {
            config: {},
            hash: "memory-proof-1",
            issues: [],
            raw: "{}",
            valid: true,
          },
          [STATUS]: statusCases(11),
          [DIARY]: scoped({ main: agentDiary("main"), support: agentDiary("support") }),
        },
      });
      const detail = () => page.locator("openclaw-agent-memory-panel .dreams__status-detail");
      const requestCount = () => gateway.getRequests(STATUS).then((requests) => requests.length);
      const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 15_000 });
      const expectPromoted = (count: number) =>
        poll(() => detail().textContent()).toContain(`${count} promoted`);
      const expectWikiUnused = async () => {
        expect(await gateway.getRequests("wiki.importInsights")).toHaveLength(0);
        expect(await gateway.getRequests("wiki.overview")).toHaveLength(0);
      };
      const waitRoute = (routeId: string, pathname: string) =>
        e2e.waitForControlUiRoute(page, { routeId, pathname });
      const chooseAgent = async (name: string) => {
        const picker = page.locator(".settings-sidebar openclaw-agent-select");
        await picker.locator(".agent-select__trigger").click();
        await picker
          .locator(".agent-select__option[data-agent-option]")
          .filter({ hasText: name })
          .evaluate((item) => (item as HTMLElement).click());
      };

      try {
        expect((await page.goto(`${server.baseUrl}settings/agents/main/memory`))?.status()).toBe(
          200,
        );
        await waitRoute("agents", "/settings/agents/main/memory");
        await expectPromoted(11);
        await expectWikiUnused();

        const beforeFirstMain = await requestCount();
        await gateway.deferNext(STATUS);
        await page.evaluate(() => {
          history.pushState(null, "", "/settings/memory/dreams");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await waitRoute("memory", "/settings/memory/dreams");
        await poll(requestCount).toBeGreaterThan(beforeFirstMain);

        const beforeSupport = await requestCount();
        await gateway.deferNext(STATUS);
        await chooseAgent("Support");
        await poll(requestCount).toBeGreaterThan(beforeSupport);
        await gateway.setMethodResponse(STATUS, statusCases(33));
        await chooseAgent("Main");
        await expectPromoted(33);
        await gateway.resolveDeferred(STATUS, status("main", 11));
        await gateway.resolveDeferred(STATUS, status("support", 22));
        await expectPromoted(33);
        await expectWikiUnused();

        await gateway.setMethodResponse(STATUS, status("main", 44));
        const beforeReconnect = await requestCount();
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1001, "proxy idle timeout");
        await gateway.setOnline(false);
        await expect
          .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase), {
            timeout: 15_000,
          })
          .toBe("reconnecting");
        await poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await gateway.setOnline(true);
        await poll(requestCount).toBeGreaterThan(beforeReconnect);
        await expectPromoted(44);
        await waitRoute("memory", "/settings/memory/dreams");
      } finally {
        await context.close();
      }
    }, 120_000);
  },
);
