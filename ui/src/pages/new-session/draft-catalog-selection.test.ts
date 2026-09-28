import { render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { t } from "../../i18n/index.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import { createDraftFixture, registerTextPayload } from "./draft-submission-flow.test-support.ts";
import type { NewSessionRouteData } from "./location.ts";

const models = [
  { id: "first", provider: "example", name: "First", available: true },
  { id: "second", provider: "example", name: "Second", available: true },
];
const targets = ["claude", "codex"].map((id) => ({
  id,
  label: id === "claude" ? "Claude Code" : "Codex",
  capabilities: { startTerminal: true },
  hosts: [],
}));
const readyTarget = (id = "claude") => ({
  catalogs: [
    {
      ...targets.find((target) => target.id === id),
      hosts: [{ hostId: "gateway:local", label: "Gateway", canStartTerminal: true }],
    },
  ],
});

// Drain the request and owner publication continuations; no timer or discovery polling.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function fixture(catalogId = "") {
  window.history.replaceState(
    {},
    "",
    "/new?agent=main" + (catalogId ? "&catalog=" + catalogId : ""),
  );
  const lookup = vi.fn<(id: string) => Promise<unknown>>(async () => ({ catalogs: targets }));
  const initialData: NewSessionRouteData = {
    agentId: "main",
    requestedAgentId: "main",
    catalogId,
    catalogLabel: catalogId,
    model: "",
    startTerminal: Boolean(catalogId),
    terminalHosts: catalogId ? [] : undefined,
  };
  const options = {
    data: initialData,
    methods: ["models.list", "sessions.catalog.list", "sessions.create"],
    agents: ["main", "research"].map((id) => ({
      id,
      workspace: "/workspace",
      model: { primary: "example/first" },
    })),
    modelCatalog: async () => ({ models }),
    request: async (method: string, params?: unknown): Promise<unknown> => {
      if (method === "sessions.catalog.list") {
        const request = params as { metadataOnly?: boolean; catalogId?: string };
        return request.metadataOnly ? { catalogs: targets } : lookup(request.catalogId!);
      }
      return {};
    },
    onTargetSelect: vi.fn(async (data: NewSessionRouteData, isCurrent: () => boolean) => {
      if (!isCurrent()) {
        return false;
      }
      options.data = data;
      const search = new URLSearchParams({ agent: data.requestedAgentId });
      if (data.catalogId) {
        search.set("catalog", data.catalogId);
      } else if (data.requestedModel) {
        search.set("model", data.requestedModel);
      }
      window.history.replaceState({}, "", "/new?" + search.toString());
      return true;
    }),
  };
  const result = createDraftFixture(options);
  const { place, context, flow } = result;
  const selections = vi.spyOn(place.catalogSelection, "selectCatalogTarget");
  const settleSelection = async () => {
    await selections.mock.results.at(-1)?.value;
    await flush();
  };
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => {
    container.remove();
    place.modelControl.reset();
    flow.disconnect();
    result.gateway.disconnect();
  });
  place.modelControl.loadCatalogTargets(context, "main", true);
  await settleModelCatalogRequests(context.gateway.snapshot.client!, { agentId: "main" });
  await flush();
  const view = () => {
    render(
      place.modelControl.render({
        context,
        agentId: place.agentId,
        agent: place.selectedAgent(),
        sending: flow.submitting,
        catalogTarget: place.data,
      }),
      container,
    );
    return container;
  };
  const choose = (selector: string) => {
    const element = view().querySelector<HTMLButtonElement>(selector);
    expect(element).not.toBeNull();
    element!.click();
  };
  return { ...result, options, lookup, view, choose, settleSelection };
}

afterEach(() => window.history.replaceState({}, "", "/"));

describe("native CLI picker admission", () => {
  it("locks changes only while an accepted target commits its route", async () => {
    const f = await fixture();
    const pendingNavigation = createDeferred();
    const committing = createDeferred();
    const commit = f.options.onTargetSelect.getMockImplementation();
    if (!commit) {
      throw new Error("Missing route fixture");
    }
    f.options.onTargetSelect.mockImplementation(async (data, isCurrent) => {
      if (!isCurrent()) {
        return false;
      }
      committing.resolve();
      await pendingNavigation.promise;
      // An admitted browser navigation is not canceled by invalidating its callback.
      await commit(data, () => true);
      return isCurrent();
    });
    f.lookup.mockResolvedValue(readyTarget());
    f.flow.setMessage("Keep the admitted target and draft");
    const previousModel = f.place.modelControl.modelForSubmission();
    const currentView = f.view();
    const nextNative = currentView.querySelector<HTMLButtonElement>(
      '[data-chat-model-target="codex"]',
    );
    const nextModel = currentView.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="example/second"]',
    );
    if (!nextNative || !nextModel) {
      throw new Error("Missing recovery choices");
    }
    f.choose('[data-chat-model-target="claude"]');
    await committing.promise;
    try {
      // Exercise callbacks from the previously rendered menu as well as its locked projection.
      nextNative.click();
      nextModel.click();
      await f.flow.submit();
      expect(f.flow.blockedSubmitNotice()).toBeUndefined();
      expect(f.lookup).toHaveBeenCalledTimes(1);
      expect(f.place.modelControl.modelForSubmission()).toBe(previousModel);
      expect(
        f.view().querySelector("[data-chat-model-select]")?.getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        f.request.mock.calls.filter(
          ([method]) => method === "sessions.create" || method === "sessions.catalog.startTerminal",
        ),
      ).toHaveLength(0);
    } finally {
      pendingNavigation.resolve();
      await Promise.all(f.options.onTargetSelect.mock.results.map((result) => result.value));
      await f.settleSelection();
    }
    expect(f.place.data?.catalogId).toBe("claude");
    expect(f.flow.message).toBe("Keep the admitted target and draft");
    expect(f.view().querySelector("[data-chat-model-select]")?.getAttribute("aria-disabled")).toBe(
      "false",
    );
    f.choose('[data-chat-model-option="example/second"]');
    await flush();
    expect(f.place.data?.catalogId).toBe("");
    expect(f.place.modelControl.modelForSubmission()).toBe("example/second");
  });

  it.each(["claude", "codex"])(
    "keeps the draft and picker on unavailable %s, retries once, and recovers to a model",
    async (id) => {
      const f = await fixture();
      const attachment = registerTextPayload("native-picker-draft-" + id);
      f.flow.setMessage("Keep this prompt");
      f.flow.attachmentDraft.replace([attachment]);
      const originalFolder = f.place.folder;
      const pending = createDeferred<unknown>();
      f.lookup.mockReturnValueOnce(pending.promise);
      const picker = f.view().querySelector<HTMLDetailsElement>("details")!;
      picker.open = true;
      picker.dispatchEvent(new Event("toggle"));
      f.choose('[data-chat-model-target="' + id + '"]');
      expect(
        f
          .view()
          .querySelector('[data-chat-model-target="' + id + '"]')
          ?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(picker.open).toBe(true);
      expect(f.options.onTargetSelect).not.toHaveBeenCalled();
      pending.resolve({ catalogs: targets });
      await f.settleSelection();
      expect(
        f
          .view()
          .querySelector('[data-chat-model-target="' + id + '"]')
          ?.getAttribute("title"),
      ).toBe(t("newSession.nativeHostsUnavailable"));
      expect(f.view().textContent).toContain(t("lazyView.retry"));
      expect(picker.open).toBe(true);
      expect(f.place.data?.catalogId).toBe("");
      expect(f.flow.message).toBe("Keep this prompt");
      expect(f.flow.attachmentDraft.attachments).toEqual([attachment]);
      expect(f.place.folder).toBe(originalFolder);
      expect(f.lookup).toHaveBeenCalledTimes(1);

      f.lookup.mockResolvedValue(readyTarget(id));
      f.choose('[data-chat-model-target="' + id + '"]');
      await f.settleSelection();
      expect(f.options.onTargetSelect).toHaveBeenCalledTimes(1);
      expect(f.place.data?.catalogId).toBe(id);
      expect(window.location.search).toContain("catalog=" + id);
      expect(f.view().querySelector(".chat-controls__model-picker")).not.toBeNull();
      expect(f.view().querySelector(".chat-controls__effort-picker")).toBeNull();
      expect(f.flow.message).toBe("Keep this prompt");
      expect(f.lookup).toHaveBeenCalledTimes(2);

      f.choose('[data-chat-model-option="example/second"]');
      await flush();
      expect(f.place.data?.catalogId).toBe("");
      expect(window.location.search).not.toContain("catalog=");
      expect(f.place.modelControl.modelForSubmission()).toBe("example/second");
      expect(f.flow.message).toBe("Keep this prompt");
      expect(f.flow.attachmentDraft.attachments).toEqual([attachment]);
      expect(f.lookup).toHaveBeenCalledTimes(2);
      expect(
        f.request.mock.calls.filter(
          ([method, params]) =>
            method === "sessions.catalog.list" &&
            (params as { metadataOnly?: boolean })?.metadataOnly,
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["incognito", "draft"] as const)(
    "refuses native selection without losing %s intent",
    async (visibility) => {
      const f = await fixture();
      f.flow.setVisibility(visibility);
      f.flow.setMessage("Keep private or saved");
      f.choose('[data-chat-model-target="claude"]');
      await flush();
      expect(f.options.onTargetSelect).not.toHaveBeenCalled();
      expect(f.lookup).not.toHaveBeenCalled();
      expect(f.place.data?.catalogId).toBe("");
      expect(f.flow.visibility).toBe(visibility);
      expect(f.flow.message).toBe("Keep private or saved");
      expect(
        f.view().querySelector('[data-chat-model-target="claude"]')?.getAttribute("title"),
      ).toBe(t("newSession.terminalVisibilityUnsupported"));
    },
  );

  it("recovers a direct unavailable catalog route without a native host lookup", async () => {
    const f = await fixture("codex");
    f.flow.setMessage("Direct route draft");
    expect(f.place.selectedAgent()?.id).toBe("main");
    expect(f.place.data?.startTerminal).toBe(true);
    expect(f.view().querySelector('[data-chat-model-target="codex"]')?.getAttribute("title")).toBe(
      t("newSession.nativeHostsUnavailable"),
    );
    f.choose('[data-chat-model-option="example/second"]');
    await flush();
    expect(f.place.data?.catalogId).toBe("");
    expect(f.flow.message).toBe("Direct route draft");
    expect(f.lookup).not.toHaveBeenCalled();
    expect(window.location.search).toContain("model=example%2Fsecond");
  });

  it.each([
    "model",
    "agent",
    "route",
    "location",
    "gateway",
    "hello",
    "client",
    "identity",
    "disconnect",
    "submission",
    "incognito",
  ] as const)("does not commit late native success after %s changes", async (change) => {
    const f = await fixture();
    const pending = createDeferred<unknown>();
    f.lookup.mockReturnValue(pending.promise);
    f.choose('[data-chat-model-target="claude"]');
    const gateway = f.context.gateway;
    switch (change) {
      case "model":
        f.choose('[data-chat-model-option="example/second"]');
        break;
      case "agent":
        f.place.selectAgentId("research");
        break;
      case "route":
        f.options.data = { ...f.options.data, requestedModel: "example/second" };
        break;
      case "location":
        window.history.replaceState({}, "", "/new?agent=research");
        break;
      case "gateway":
        Object.assign(f.context, { gateway: { ...gateway } });
        break;
      case "hello":
        Object.assign(gateway.snapshot, { hello: { ...gateway.snapshot.hello } });
        break;
      case "client":
        Object.assign(gateway.snapshot, { client: { request: vi.fn() } });
        break;
      case "identity":
        Object.assign(gateway.snapshot, { selfUser: { id: "different" } });
        break;
      case "disconnect":
        gateway.snapshot.phase = "offline";
        break;
      case "submission":
        await f.flow.submit();
        break;
      case "incognito":
        f.flow.setVisibility("incognito");
        break;
    }
    pending.resolve(readyTarget());
    await flush();
    expect(f.options.onTargetSelect).not.toHaveBeenCalled();
    expect(f.place.data?.catalogId).toBe("");
  });

  it("holds submission while the accepted target moves the same draft to its URL", async () => {
    const f = await fixture();
    const entered = createDeferred();
    const release = createDeferred();
    const navigate = f.options.onTargetSelect.getMockImplementation()!;
    f.options.onTargetSelect.mockImplementationOnce(async (data, isCurrent) => {
      entered.resolve();
      await release.promise;
      return navigate(data, isCurrent);
    });
    f.lookup.mockResolvedValue(readyTarget());
    f.flow.setMessage("Keep until the route is ready");
    f.choose('[data-chat-model-target="claude"]');
    await entered.promise;
    expect(f.flow.canSubmit()).toBe(false);
    await f.flow.submit();
    expect(f.context.sessions.createResult).not.toHaveBeenCalled();
    expect(f.flow.message).toBe("Keep until the route is ready");
    release.resolve();
    await f.settleSelection();
    expect(f.place.data?.catalogId).toBe("claude");
  });

  it("lets a newer CLI target win and ignores the older failed response", async () => {
    const f = await fixture();
    const old = createDeferred<unknown>();
    f.lookup.mockImplementation((id) =>
      id === "claude" ? old.promise : Promise.resolve(readyTarget("codex")),
    );
    f.choose('[data-chat-model-target="claude"]');
    f.choose('[data-chat-model-target="codex"]');
    await f.settleSelection();
    old.reject(new Error("old lookup failed"));
    await old.promise.catch(() => undefined);
    await flush();
    expect(f.place.data?.catalogId).toBe("codex");
    expect(f.options.onTargetSelect).toHaveBeenCalledTimes(1);
    expect(f.view().querySelector('[data-chat-model-target="claude"]')?.hasAttribute("title")).toBe(
      false,
    );
  });
});
