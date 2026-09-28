import { createRouter } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { AgentSelect } from "../../components/agent-select.ts";
import { t } from "../../i18n/index.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { NewSessionDictationControl } from "./composer-dictation-control.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";
import { load } from "./route-loader.ts";
import { page as newSessionRoute } from "./route.ts";
import "./new-session-page-entry.ts";

type NewSessionElement = HTMLElement & {
  data: NewSessionRouteData | undefined;
  focusComposer(): void;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

function routeData(agentId: string, catalogId = ""): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId,
    model: "",
    catalogLabel: "",
    startTerminal: false,
  };
}

async function mount(data: NewSessionRouteData): Promise<NewSessionElement> {
  const page = document.createElement("openclaw-new-session-page") as NewSessionElement;
  page.data = data;
  document.body.append(page);
  await settle(page);
  return page;
}

async function settle(page: NewSessionElement) {
  await page.updateComplete;
  await page.updateComplete;
}

async function enterMessage(page: NewSessionElement, value: string) {
  const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
  expect(textarea).not.toBeNull();
  if (!textarea) {
    return;
  }
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await settle(page);
}

function message(page: NewSessionElement): string {
  return page.querySelector<HTMLTextAreaElement>(".new-session-page__message")?.value ?? "";
}

afterEach(() => {
  document.querySelectorAll("openclaw-new-session-page").forEach((element) => element.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("new session draft route ownership", () => {
  it("uses one lookup per native selection when the router republishes a cached destination before loading", async () => {
    const fixture = createDraftFixture({
      methods: ["models.list", "sessions.catalog.list"],
      modelCatalog: async () => ({
        models: [{ id: "recovery", provider: "example", name: "Recovery", available: true }],
      }),
      request: async (method) =>
        method === "sessions.catalog.list"
          ? {
              catalogs: [
                {
                  id: "codex",
                  label: "Codex",
                  capabilities: { startTerminal: true },
                  hosts: [{ hostId: "gateway:local", label: "Gateway", canStartTerminal: true }],
                },
              ],
            }
          : {},
    });
    const { context } = fixture;
    const subscribe = () => () => undefined;
    Object.assign(context.agents, { subscribe });
    Object.assign(context.agents.state, {
      connected: true,
      client: context.gateway.snapshot.client,
    });
    Object.assign(context.sessions, {
      subscribe,
      groupsGeneration: () => 0,
      groupsStatus: () => "ready",
    });
    Object.assign(context.sessions.state, { groupSettings: [] });
    Object.assign(context.config, { subscribe });
    Object.assign(context.placementStartup, { subscribe });
    Object.assign(context, {
      agentIdentity: { subscribe, get: () => undefined, ensure: async () => undefined },
      theme: { subscribe, settings: {}, branding: { mascot: "none" } },
      runtimeConfig: { subscribe, state: { configSnapshot: null } },
    });
    const handoff = createChatAttachmentHandoff(context.gateway);
    Object.assign(context, { chatAttachmentHandoff: handoff });
    const provider = createApplicationContextProvider(context);
    const page = document.createElement("openclaw-new-session-page") as NewSessionElement;
    let heldLoader: ReturnType<typeof createDeferred<void>> | undefined;
    const router = createRouter<"new-session", ApplicationContext, unknown, NewSessionRouteData>({
      routes: [
        {
          ...newSessionRoute,
          loader: async (routeContext, options) => {
            // Hold the lazy loader boundary while the real router publishes its cached module/data.
            if (heldLoader) {
              await heldLoader.promise;
            }
            return newSessionRoute.loader!(routeContext, options);
          },
        },
      ],
    });
    Object.assign(context, { router });
    let cachedNative: NewSessionRouteData | undefined;
    const cachedPublished = createDeferred();
    const stop = router.subscribe(({ matches }) => {
      const match = matches[0];
      if (!match) {
        return;
      }
      window.history.replaceState({}, "", match.location.pathname + match.location.search);
      page.data = match.data;
      if (heldLoader && match.data === cachedNative && match.isFetching === "loader") {
        cachedPublished.resolve();
      }
    });
    let entered = createDeferred();
    const navigate = vi
      .mocked(context.navigateAndWait)
      .mockImplementation(async (_route, options) => {
        entered.resolve();
        await router.navigate("new-session", context, undefined, {
          pathname: "/new",
          search: options?.search ?? "",
          hash: "",
        });
        await settle(page);
      });
    const choose = async (selector: string) => {
      entered = createDeferred();
      const choice = page.querySelector<HTMLButtonElement>(selector);
      expect(choice).not.toBeNull();
      choice!.click();
      await entered.promise;
      await navigate.mock.results.at(-1)?.value;
      await settle(page);
      await settle(page);
    };
    const targetedReads = () =>
      fixture.request.mock.calls.filter(
        ([method, params]) =>
          method === "sessions.catalog.list" &&
          (params as { catalogId?: string })?.catalogId === "codex",
      );
    try {
      await router.navigate("new-session", context, undefined, {
        pathname: "/new",
        search: "?agent=main",
        hash: "",
      });
      provider.append(page);
      document.body.append(provider);
      await settle(page);
      await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId: "main" });
      await settle(page);
      await enterMessage(page, "Keep this draft across cached routes");
      const textarea = page.querySelector("textarea");
      await choose('[data-chat-model-target="codex"]');
      cachedNative = page.data;
      expect(targetedReads()).toHaveLength(1);
      await enterMessage(page, "Edited native draft");
      await choose('[data-chat-model-option="example/recovery"]');
      expect(message(page)).toBe("Edited native draft");
      heldLoader = createDeferred();
      const secondSelection = choose('[data-chat-model-target="codex"]');
      try {
        await cachedPublished.promise;
        await settle(page);
        expect(page.data).toBe(cachedNative);
      } finally {
        heldLoader.resolve();
        await secondSelection;
      }
      expect(targetedReads()).toHaveLength(2);
      expect(page.data).not.toBe(cachedNative);
      expect(page.data?.catalogId).toBe("codex");
      expect(message(page)).toBe("Edited native draft");
      expect(page.querySelector("textarea")).toBe(textarea);
      expect(page.querySelector("[data-chat-model-select]")?.getAttribute("aria-disabled")).toBe(
        "false",
      );
    } finally {
      heldLoader?.resolve();
      stop();
      router.stop();
      provider.remove();
      fixture.place.modelControl.reset();
      fixture.flow.disconnect();
      fixture.gateway.disconnect();
      handoff.dispose();
    }
  });

  it.each(["normal", "native", "unavailable"] as const)(
    "keeps the canonical header for %s",
    async (state) => {
      const page = await mount({
        ...routeData("main", state === "normal" ? "" : "anthropic"),
        catalogLabel: state === "native" ? "Claude Code" : "",
        startTerminal: state === "native",
        terminalHosts: state === "native" ? [{ hostId: "gateway:local", label: "Gateway" }] : [],
      });
      expect(page.querySelector(".agent-chat__hint")?.textContent?.trim()).toBe(
        "Pick where this session works, then say what to do.",
      );
    },
  );

  it.each(["rejected", "stale"] as const)(
    "retires a %s picker handoff and accepts the next navigation with the same draft",
    async (outcome) => {
      const data = { ...routeData("main", "codex"), catalogLabel: "Codex", startTerminal: true };
      window.history.replaceState({}, "", "/new?agent=main&catalog=codex");
      const fixture = createDraftFixture({
        data,
        agents: ["main", "research"].map((id) => ({
          id,
          workspace: "/workspace",
          model: { primary: "openai/gpt-5.6-luna" },
        })),
        modelCatalog: async () => ({
          models: [{ id: "recovery", provider: "example", name: "Recovery", available: true }],
        }),
      });
      const { context } = fixture;
      const subscribe = () => () => undefined;
      Object.assign(context.agents, { subscribe });
      Object.assign(context.sessions, {
        subscribe,
        groupsGeneration: () => 0,
        groupsStatus: () => "ready",
      });
      Object.assign(context.sessions.state, { groupSettings: [] });
      Object.assign(context.config, { subscribe });
      Object.assign(context.placementStartup, { subscribe });
      Object.assign(context, {
        agentIdentity: { subscribe, get: () => undefined, ensure: async () => undefined },
        theme: { subscribe, settings: {}, branding: { mascot: "none" } },
        runtimeConfig: { subscribe, state: { configSnapshot: null } },
      });
      const handoff = createChatAttachmentHandoff(context.gateway);
      Object.assign(context, { chatAttachmentHandoff: handoff });
      const prepare = handoff.prepare.bind(handoff);
      const cancellations = vi.fn();
      const prepared = vi.spyOn(handoff, "prepare").mockImplementation((entry) => {
        const cancel = prepare(entry);
        return () => {
          cancellations();
          cancel?.();
        };
      });
      const navigate = vi.mocked(context.navigateAndWait);
      if (outcome === "rejected") {
        navigate.mockRejectedValueOnce(new Error("Navigation rejected"));
      }
      const provider = createApplicationContextProvider(context);
      const page = document.createElement("openclaw-new-session-page") as NewSessionElement;
      page.data = data;
      provider.append(page);
      document.body.append(provider);
      try {
        await settle(page);
        await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId: "main" });
        await settle(page);
        await enterMessage(page, "Keep this navigation draft");
        const choose = () => {
          const choice = page.querySelector<HTMLButtonElement>(
            '[data-chat-model-option="example/recovery"]',
          );
          expect(choice).not.toBeNull();
          choice!.click();
        };
        choose();
        await navigate.mock.results.at(-1)?.value.catch(() => undefined);
        await settle(page);
        await settle(page);
        expect(prepared).toHaveBeenCalledOnce();
        expect(cancellations).toHaveBeenCalledOnce();
        expect(page.data?.catalogId).toBe("codex");
        expect(message(page)).toBe("Keep this navigation draft");

        const admitted = createDeferred();
        const release = createDeferred();
        navigate.mockImplementationOnce(async (_route, options) => {
          admitted.resolve();
          await release.promise;
          const search = options?.search ?? "";
          page.data = await load(context, search, "navigation");
          window.history.replaceState({}, "", "/new" + search);
          await settle(page);
        });
        choose();
        await admitted.promise;
        await settle(page);
        try {
          const agent = page.querySelector<AgentSelect>("openclaw-agent-select");
          expect(agent?.disabled).toBe(true);
          agent?.onSelect("research");
          expect(page.querySelector(".new-session-page__incognito-toggle")).toBeNull();
        } finally {
          release.resolve();
          await navigate.mock.results.at(-1)?.value;
        }
        await settle(page);
        await settle(page);
        expect(page.data?.requestedModel).toBe("example/recovery");
        expect(message(page)).toBe("Keep this navigation draft");
        expect(page.querySelector("[data-chat-model-select]")?.textContent).toContain("Recovery");
      } finally {
        provider.remove();
        fixture.place.modelControl.reset();
        fixture.flow.disconnect();
        fixture.gateway.disconnect();
        handoff.dispose();
      }
    },
  );

  it("focuses an opened draft and refocuses without changing its message", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
    expect(document.activeElement).toBe(textarea);
    await enterMessage(page, "Keep this draft; do not submit it");
    const other = document.body.appendChild(document.createElement("button"));
    try {
      other.focus();
      page.focusComposer();
      await settle(page);
      expect(document.activeElement).toBe(textarea);
      expect(message(page)).toBe("Keep this draft; do not submit it");
      page.focusComposer();
      other.focus();
      await settle(page);
      expect(document.activeElement).toBe(other);
      (document.openClawModalLayers ??= new Set()).add(other);
      other.focus();
      page.focusComposer();
      await settle(page);
      expect(document.activeElement).toBe(other);
    } finally {
      document.openClawModalLayers?.delete(other);
      other.remove();
    }
  });

  it.each(["show in composer", "finish dictation", "change route", "disconnect"] as const)(
    "opens pasted text in the shared side panel and clears it on %s",
    async (transition) => {
      let dictating = false;
      if (transition === "finish dictation") {
        vi.spyOn(NewSessionDictationControl.prototype, "active", "get").mockImplementation(
          () => dictating,
        );
      }
      const page = await mount(routeData("research"));
      const original = "# Original pasted content\n  preserve indentation 漢字 😀\n".repeat(50);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(original));
      vi.stubGlobal("fetch", fetchMock);
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { items: [], getData: () => original },
      });
      page.querySelector("textarea")?.dispatchEvent(paste);
      expect(paste.defaultPrevented).toBe(true);
      await settle(page);
      await expect
        .poll(() => page.querySelector("openclaw-chat-pasted-text .chat-attachment-file__open"))
        .not.toBeNull();
      if (transition === "finish dictation") {
        dictating = true;
        page.requestUpdate();
        await settle(page);
        expect(page.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(true);
      }
      page
        .querySelector<HTMLElement>("openclaw-chat-pasted-text .chat-attachment-file__open")
        ?.click();
      await expect.poll(() => page.querySelector("openclaw-chat-detail-panel")).not.toBeNull();
      await expect
        .poll(() => {
          const source = page
            .querySelector<HTMLAnchorElement>("openclaw-chat-detail-panel a[download]")
            ?.getAttribute("href");
          return Boolean(source && fetchMock.mock.calls.some(([url]) => url === source));
        })
        .toBe(true);
      await expect
        .poll(() => page.querySelector("openclaw-chat-detail-panel pre")?.textContent)
        .toBe(original);

      if (transition === "finish dictation") {
        const actionButtons = () => [
          ...page.querySelectorAll<HTMLButtonElement>(
            "openclaw-chat-detail-panel .chat-attachment-text-action, openclaw-chat-detail-panel button[aria-label^='Remove']",
          ),
        ];
        expect(actionButtons()).toHaveLength(2);
        expect(actionButtons().every((button) => button.disabled)).toBe(true);
        dictating = false;
        page.requestUpdate();
        await expect.poll(() => actionButtons().every((button) => !button.disabled)).toBe(true);
      }
      if (transition === "show in composer" || transition === "finish dictation") {
        await enterMessage(page, "Typed while preview is open");
        const show = [
          ...page.querySelectorAll<HTMLButtonElement>("openclaw-chat-detail-panel button"),
        ].find((button) => button.textContent?.trim() === t("chat.attachments.showInTextField"));
        expect(show).toBeDefined();
        show?.click();
        await settle(page);
        expect(message(page)).toBe(`Typed while preview is open\n\n${original}`);
        expect(page.querySelector("openclaw-chat-pasted-text")).toBeNull();
      } else if (transition === "change route") {
        window.history.replaceState({}, "", "/new?agent=main");
        page.data = routeData("main");
        await settle(page);
      } else {
        page.remove();
        await settle(page);
      }
      expect(page.querySelector("openclaw-chat-detail-panel")).toBeNull();
    },
  );

  it("routes every focus-surface and key-class pair by the shared contract", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");
    expect(textarea).not.toBeNull();
    if (!textarea) {
      return;
    }
    const keys = ["x", " ", "Enter", "ArrowDown", "Escape"] as const;
    type Destination = "composer" | "element" | "overlay" | "nothing";
    type Surface = {
      name: string;
      targets: HTMLElement[];
      expected: readonly Destination[];
      openDialog?: boolean;
      openDropdown?: boolean;
    };
    const append = <T extends HTMLElement>(element: T): T => page.appendChild(element);
    const main = append(document.createElement("main"));
    main.tabIndex = -1;
    const button = append(document.createElement("button"));
    const link = append(document.createElement("a"));
    link.href = "#target";
    const menu = append(document.createElement("wa-dropdown")) as HTMLElement & { open: boolean };
    const menuItem = menu.appendChild(document.createElement("wa-dropdown-item"));
    menuItem.setAttribute("role", "menuitemradio");
    menuItem.tabIndex = -1;
    const dialog = append(document.createElement("dialog"));
    dialog.open = true;
    const dialogButton = dialog.appendChild(document.createElement("button"));
    const details = append(document.createElement("details"));
    details.open = true;
    const summary = details.appendChild(document.createElement("summary"));
    const input = append(document.createElement("input"));
    const editable = append(document.createElement("div"));
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    const element = ["element", "element", "element", "element", "element"] as const;
    const overlay = ["overlay", "overlay", "overlay", "overlay", "overlay"] as const;
    const routing: Surface[] = [
      {
        name: "main",
        targets: [main],
        expected: ["composer", "composer", "nothing", "nothing", "nothing"],
      },
      { name: "composer", targets: [textarea], expected: element },
      {
        name: "button/link",
        targets: [button, link],
        expected: ["composer", "element", "element", "nothing", "nothing"],
      },
      {
        name: "menuitem",
        targets: [menuItem],
        expected: ["composer", "overlay", "overlay", "overlay", "overlay"],
        openDropdown: true,
      },
      {
        name: "open wa-dropdown",
        targets: [main],
        expected: ["composer", "overlay", "overlay", "overlay", "overlay"],
        openDropdown: true,
      },
      { name: "dialog", targets: [dialogButton], expected: overlay, openDialog: true },
      {
        name: "details/summary",
        targets: [summary],
        expected: ["composer", "element", "element", "nothing", "nothing"],
      },
      { name: "input/contenteditable", targets: [input, editable], expected: element },
    ];

    for (const row of routing) {
      for (const target of row.targets) {
        for (const [index, key] of keys.entries()) {
          menu.open = row.openDropdown === true;
          dialog.open = row.openDialog === true;
          target.focus();
          target.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, composed: true }),
          );
          const destination = row.expected[index];
          if (destination === "composer") {
            expect(document.activeElement, `${row.name} / ${key} -> composer`).toBe(textarea);
          } else if (destination === "overlay") {
            expect(document.activeElement, `${row.name} / ${key} -> overlay`).not.toBe(textarea);
          } else {
            expect(document.activeElement, `${row.name} / ${key} -> ${destination}`).toBe(target);
          }
        }
      }
    }
  });

  it("leaves shortcuts, composition, and other form controls alone", async () => {
    const page = await mount(routeData("research"));
    const neutral = page.appendChild(document.createElement("button"));
    neutral.focus();

    for (const init of [
      { key: "x", ctrlKey: true },
      { key: "x", metaKey: true },
      { key: "Tab" },
      { key: "Escape" },
      { key: "Process", isComposing: true },
    ]) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { ...init, bubbles: true, composed: true }),
      );
      expect(document.activeElement).toBe(neutral);
    }

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    for (const control of [
      document.createElement("input"),
      document.createElement("select"),
      document.createElement("textarea"),
      editable,
    ]) {
      page.append(control);
      control.focus();
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true, composed: true }),
      );
      expect(document.activeElement).toBe(control);
    }
  });

  it("labels the message input independently of its placeholder", async () => {
    const page = await mount(routeData("research"));
    const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message");

    expect(textarea?.getAttribute("aria-label")).toBe(t("newSession.messagePlaceholder"));
  });

  it("clears source draft state when destination data is still pending", async () => {
    const page = await mount(routeData("research"));
    window.history.replaceState({}, "", "/new?agent=research");
    await enterMessage(page, "source draft");

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
  });

  it("keeps destination input through pending data, settlement, and agent resolution", async () => {
    const page = await mount(routeData("research"));

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    await settle(page);
    await enterMessage(page, "keep this fast draft");

    page.data = { ...routeData("", "claude"), requestedAgentId: "research" };
    await settle(page);
    expect(message(page)).toBe("keep this fast draft");

    page.data = routeData("research", "claude");
    await settle(page);
    expect(message(page)).toBe("keep this fast draft");
  });

  it("clears a draft when a different route settles without destination-owned input", async () => {
    const page = await mount(routeData("research", "claude"));
    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    await enterMessage(page, "route-owned draft");

    window.history.replaceState({}, "", "/new?agent=main&catalog=codex");
    page.data = undefined;
    await settle(page);

    expect(message(page)).toBe("");
  });
});
