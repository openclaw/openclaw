import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayAgentRow, ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import { createGatewayMetadataObserver } from "../../app/gateway-observers.ts";
import {
  beginChatMetadataPublication,
  subscribeChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { resetWorktreeMocks } from "./draft-worktree-checks.test-support.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import { disposeWorktreeDraft } from "./draft-worktree-submission.test-support.ts";
import {
  controlQueries,
  modelOption,
  managedModelControls,
  testModel,
  thinkingLevels,
} from "./model-control-view-queries.test-support.ts";
import { contextWith, renderControl, waitForModelControl } from "./model-control.test-support.ts";
import type { NewSessionModelControl } from "./model-control.ts";
import { loadNewSessionPreference } from "./preferences.ts";

const managed = managedModelControls();
afterEach(() => {
  managed.reset();
  resetWorktreeMocks();
});

function setupModel(models: ModelCatalogEntry[], agent?: GatewayAgentRow) {
  const state = contextWith(models);
  const savePreference = vi.fn();
  const control = managed.make(() => undefined, savePreference);
  return {
    ...state,
    control,
    savePreference,
    ...controlQueries(control, state.context, "main", agent),
    blocked: () => control.modelSelectionBlockedReason(agent),
    model: () => control.modelForSubmission(),
    ready: () => control.accountSelectionReady(),
    load: () => control.load(state.context, "main", true, { agent }),
  };
}

async function retainCatalog(models: ModelCatalogEntry[], agent: GatewayAgentRow) {
  const fixture = setupModel(models, agent);
  fixture.load();
  const last = models[models.length - 1]!;
  await vi.waitFor(() =>
    expect(modelOption(fixture.draw(), `${last.provider}/${last.id}`)).not.toBeNull(),
  );
  const retire = () => {
    fixture.control.reset();
    invalidateModelCatalogCache(fixture.context.gateway.snapshot.client!, { agentId: "main" });
  };
  return { ...fixture, retire };
}

function retainedAccountDraft(mode?: "retire" | "permitted-default" | "provider-switch") {
  const model = testModel("anthropic", "model", {
    available: false,
    unavailableReason: "missing-auth",
  });
  const account = {
    authProfileId: "personal:person-a:anthropic:one",
    provider: "anthropic",
    label: "Saved account A1",
    authType: "token",
    selected: false,
  };
  const agent = { id: "main", model: { primary: "anthropic/model" } };
  const fixture = setupModel([model], agent);
  const { context, request, control, find, draw, blocked } = fixture;
  Object.assign(context.gateway.snapshot, { selfUser: { id: "person-a", name: "Person A" } });
  const preview = deferred<ModelCatalogResult>();
  const neutral: ModelCatalogResult = {
    models: [model],
    accountSelection: { kind: "automatic", label: "Automatic" },
  };
  const connected: ModelCatalogResult = {
    models: [{ ...model, available: true, unavailableReason: undefined }],
    accountSelection: {
      kind: "personal",
      authProfileId: account.authProfileId,
      label: account.label,
    },
  };
  request.mockImplementation((method: string, params: { authProfileId?: string }) => {
    if (method === "users.listModelAccounts") {
      return Promise.resolve({ profileId: "person-a", accounts: [account], links: [] });
    }
    return params.authProfileId ? preview.promise : Promise.resolve(neutral);
  });
  control.load(context, "main", true, { agent });
  if (mode === "retire" || mode === "provider-switch") {
    Object.assign(context.config.current, { newSessionModelDefaults: "configured" });
  }
  if (mode === "permitted-default") {
    agent.model.primary = "openai/other";
    neutral.modelSelectionPolicy = connected.modelSelectionPolicy = {
      restricted: true,
      defaultModel: "anthropic/model",
    };
  }
  if (mode) {
    const extra =
      mode === "provider-switch"
        ? { id: "other", name: "Other provider", provider: "openai", available: true }
        : { id: "alternate", name: "Alternate", provider: "anthropic", available: true };
    neutral.models.push(extra);
    connected.models.push(extra);
  }
  const select = (value: string) => {
    if (!find("account-option", value)) {
      find("account-group-toggle")!.click();
      flush();
    }
    find("account-option", value)!.click();
  };
  const chooseAccount = async () => {
    await vi.waitFor(() => expect(blocked()).toContain("No provider credential"));
    await waitForModelControl(control, context, "main", agent);
    find("account-group-toggle")!.click();
    await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
    select(`account:${account.authProfileId}`);
    return {
      completion: vi.waitFor(() => expect(blocked()).not.toBe("Loading models…")),
    };
  };
  return {
    ...fixture,
    account,
    agent,
    preview,
    connected,
    select,
    chooseAccount,
    connect: async () => {
      const { completion } = await chooseAccount();
      preview.resolve(connected);
      await completion;
    },
  };
}

it("retires a consumed personal-account model before the next configured draft", async () => {
  const f = retainedAccountDraft("retire");
  await f.connect();
  f.find("model-option", "anthropic/alternate")!.click();
  expect(f.model()).toContain("anthropic/alternate@");
  f.control.retireDraftSelection();
  expect(f.model()).toBe("");
  expect(f.find("account-group-toggle")?.textContent).toContain("Automatic");
});

it("keeps a personal account when Default uses the role-permitted provider rather than the agent default", async () => {
  const f = retainedAccountDraft("permitted-default");
  await f.connect();
  f.find("model-option", "anthropic/alternate")!.click();
  expect(f.model()).toBe("anthropic/alternate@personal:person-a:anthropic:one");
  f.find("model-default", "true")!.click();
  expect(f.model()).toBe("anthropic/model@personal:person-a:anthropic:one");
  expect(f.ready()).toBe(true);
});

it("keeps a deliberate provider switch when leaving a personal account for a cached catalog", async () => {
  const f = retainedAccountDraft("provider-switch");
  await f.connect();
  const reads = f.request.mock.calls.filter(([method]) => method === "models.list").length;
  f.find("model-option", "openai/other")!.click();
  expect(f.model()).toBe("openai/other");
  expect(f.savePreference).toHaveBeenLastCalledWith(
    expect.objectContaining({ model: "openai/other" }),
  );
  expect(f.request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(reads);
});

it.each(["empty", "rejection"])(
  "displays invalidated models on remount without restoring preferences before %s",
  async (outcome) => {
    const models = ["first", "second"].map((id) =>
      testModel("fixture", id, {
        available: true,
        agentRuntime: { id: "sample-runtime", cloudPlacementSupported: false, source: "model" },
      }),
    );
    const agent: GatewayAgentRow = {
      id: "main",
      model: { primary: "fixture/first" },
      agentRuntime: { id: "sample-runtime", cloudPlacementSupported: true, source: "agent" },
    };
    const { context, request, control: firstControl, retire } = await retainCatalog(models, agent);
    const draw = (control: NewSessionModelControl) =>
      renderControl(control, context, "main", agent);
    const cloudPlacement = (control: NewSessionModelControl) =>
      control.resolveAgentRuntime({ agent, context })?.cloudPlacementSupported;
    expect(cloudPlacement(firstControl)).toBe(false);
    retire();
    const replacement = deferred<ModelCatalogResult>();
    request.mockReturnValueOnce(replacement.promise);
    const savePreference = vi.fn();
    const remounted = managed.make(() => undefined, savePreference);
    const preference = { model: "fixture/remembered", thinkingLevel: "high" };

    remounted.load(context, "main", true, { agent, preference });
    expect(modelOption(draw(remounted), "fixture/second")).not.toBeNull();
    expect(remounted.isRestoringPreference()).toBe(true);
    expect(remounted.selected).toBe("");
    expect(cloudPlacement(remounted)).toBe(true);
    remounted.load(context, "main", true, { agent, preference });
    expect(savePreference).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    if (outcome === "rejection") {
      replacement.reject(new Error("Catalog unavailable"));
    } else {
      replacement.resolve({ models: [] });
    }
    await vi.waitFor(() => expect(remounted.isRestoringPreference()).toBe(false));
    const container = draw(remounted);
    expect(modelOption(container, "fixture/second") !== null).toBe(outcome === "rejection");
    if (outcome === "rejection") {
      expect(savePreference).not.toHaveBeenCalled();
      expect(remounted).toMatchObject({
        selected: preference.model,
        thinkingLevel: preference.thinkingLevel,
      });
      modelOption(container, "fixture/second")?.click();
      expect(remounted.selected).toBe("fixture/second");
      expect(cloudPlacement(remounted)).toBe(false);
    } else {
      expect(cloudPlacement(remounted)).toBe(true);
    }
  },
);

it("does not complete a retained account preview before its replacement is accepted", async () => {
  const f = retainedAccountDraft();
  await f.connect();
  f.select("automatic");
  await vi.waitFor(() => expect(f.blocked()).toContain("No provider credential"));
  invalidateModelCatalogCache(f.context.gateway.snapshot.client!, {
    agentId: "main",
    authProfileId: f.account.authProfileId,
  });
  const replacement = deferred<ModelCatalogResult>();
  f.request.mockImplementation((method: string) =>
    method === "models.list"
      ? replacement.promise
      : Promise.resolve({ profileId: "person-a", accounts: [f.account], links: [] }),
  );

  f.find("account-group-toggle")!.click();
  await vi.waitFor(() => expect(f.draw().textContent).toContain(f.account.label));
  f.select(`account:${f.account.authProfileId}`);
  expect(modelOption(f.draw(), "anthropic/model")).not.toBeNull();
  expect(f.blocked()).toBe("Loading models…");
  expect(f.ready()).toBe(false);
  expect(f.find("account-selection")?.dataset.chatAccountSelection).toBe("automatic");
  replacement.resolve(f.connected);
  await vi.waitFor(() => expect(f.ready()).toBe(true));
  expect(f.savePreference).not.toHaveBeenCalled();
});

it.each(["agent", "client", "identity", "handshake", "disconnect"])(
  "clears retained display and fences its late replacement after changing %s",
  async (change) => {
    const model = testModel("fixture", "retained", { name: "Retained", available: true });
    const agent = { id: "main", model: { primary: "fixture/retained" } };
    const { context, request, retire } = await retainCatalog([model], agent);
    retire();
    const retired = deferred<ModelCatalogResult>();
    const current = deferred<ModelCatalogResult>();
    request.mockReturnValueOnce(retired.promise).mockReturnValue(current.promise);
    const control = managed.make(() => undefined);
    let agentId = "main";
    const draw = () => renderControl(control, context, agentId, { ...agent, id: agentId });

    control.load(context, agentId, true, { agent });
    expect(modelOption(draw(), "fixture/retained")).not.toBeNull();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const previous = { ...context.gateway.snapshot };
    if (change === "agent") {
      agentId = "research";
    } else if (change === "client") {
      Object.assign(context.gateway.snapshot, {
        client: createTestGatewayClient(() => current.promise),
      });
    } else if (change === "identity") {
      Object.assign(context.gateway.snapshot, { selfUser: { id: "person-b", name: "Person B" } });
    } else if (change === "handshake") {
      Object.assign(context.gateway.snapshot, { hello: { ...previous.hello } });
    } else {
      Object.assign(context.gateway.snapshot, { phase: "offline" });
    }
    createGatewayMetadataObserver(() => true).synchronize(previous, context.gateway.snapshot);
    control.load(context, agentId, true, { agent: { ...agent, id: agentId } });
    expect(modelOption(draw(), "fixture/retained")).toBeNull();
    current.resolve({ models: [{ ...model, id: "current", name: "Current" }] });
    if (change === "agent" || change === "client") {
      await vi.waitFor(() => expect(modelOption(draw(), "fixture/current")).not.toBeNull());
    }
    retired.resolve({ models: [{ ...model, id: "late", name: "Late" }] });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (change === "disconnect") {
      expect(modelOption(draw(), "fixture/current")).toBeNull();
    } else {
      await vi.waitFor(() => expect(modelOption(draw(), "fixture/current")).not.toBeNull());
    }
    expect(modelOption(draw(), "fixture/late")).toBeNull();
  },
);

it("enables a cooled-down model on reopen without a catalog event", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const model = testModel("example", "model", {
    available: false,
    unavailableReason: "cooldown",
    unavailableUntil: 12_000,
  });
  const agent = { id: "main", model: { primary: "example/model" } };
  const { request, find, load } = setupModel([model], agent);
  const option = () => find("model-option", "example/model");
  onTestFinished(() => clock.mockRestore());
  load();
  await vi.waitFor(() => expect(option()?.disabled).toBe(true));
  request.mockResolvedValueOnce({
    models: [
      { ...model, available: true, unavailableReason: undefined, unavailableUntil: undefined },
    ],
  });
  clock.mockReturnValue(12_000);
  find("model-select", "true")!.click();
  await vi.waitFor(() => expect(option()?.disabled).toBe(false));
});

it("selects a usable retained account after refresh failure without changing saved preferences", async () => {
  const f = retainedAccountDraft();
  const { completion } = await f.chooseAccount();
  expect(f.blocked()).toBe("Loading models…");
  f.preview.resolve({ ...f.connected, refreshFailed: true });
  await completion;
  expect(f.blocked()).toBeUndefined();
  expect(f.ready()).toBe(true);
  expect(f.find("model-catalog-state")).toBeNull();
  expect(f.find("account-group-toggle")?.textContent).toContain(f.account.label);
  expect(f.model()).toBe(`anthropic/model@${f.account.authProfileId}`);
  expect(f.control.selected).toBe("");
  f.select("automatic");
  await vi.waitFor(() => expect(f.blocked()).toContain("No provider credential"));
  expect(f.model()).toBe("");
  expect(f.find("account-group-toggle")?.textContent).toContain("Automatic");
  expect(f.savePreference).not.toHaveBeenCalled();
  expect(
    f.request.mock.calls.some(([method]) => /users\.(selectModelAccount|prefs\.set)/.test(method)),
  ).toBe(false);
});

it.each(["unconfirmed account", "unknown availability"])(
  "keeps an explicit account blocked after a preview with $0",
  async (outcome) => {
    const f = retainedAccountDraft();
    const { completion } = await f.chooseAccount();
    const result = { ...f.connected };
    if (outcome === "unconfirmed account") {
      result.accountSelection = undefined;
    } else {
      result.models = result.models.map((model) => ({ ...model, available: undefined }));
    }
    f.preview.resolve(result);
    await completion;
    expect(f.blocked()).toBe("Models unavailable");
  },
);

it("retires a pending personal-account preview when the user identity changes", async () => {
  const f = retainedAccountDraft();
  const { completion } = await f.chooseAccount();
  Object.assign(f.context.gateway.snapshot, { selfUser: { id: "person-b", name: "Person B" } });
  f.control.load(f.context, "main", true, { agent: f.agent });
  f.preview.resolve(f.connected);
  await completion;
  await vi.waitFor(() => expect(f.blocked()).toContain("No provider credential"));
  expect(f.model()).toBe("");
  expect(f.find("account-group-toggle")?.textContent).toContain("Automatic");
});

it("retains its neutral auth gate through pending, rejected and failed refreshes, isolated from a session projection", async () => {
  const model = testModel("test", "model", {
    available: false,
    unavailableReason: "missing-auth",
  });
  const agent = { id: "main", model: { primary: "test/model" } };
  const { context, request, emitCatalogChanged, draw, find, load, blocked } = setupModel(
    [model],
    agent,
  );
  const client = context.gateway.snapshot.client!;
  load();
  await vi.waitFor(() => expect(blocked()).toContain("No provider credential"));
  const scope = { agentId: "main", sessionKey: "agent:main:locked" };
  const release = subscribeChatMetadata(client, scope, () => {});
  beginChatMetadataPublication(client, scope).publish({
    commands: [],
    models: [{ ...model, available: true, unavailableReason: undefined }],
  });
  expect(blocked()).toContain("No provider credential");
  const pending = deferred<{ models: ModelCatalogEntry[] }>();
  request.mockReturnValueOnce(pending.promise);
  emitCatalogChanged();
  expect(blocked()).toContain("No provider credential");
  pending.resolve({ models: [{ ...model, unavailableReason: "auth-failed" }] });
  await vi.waitFor(() => expect(blocked()).toContain("Authentication failed"));
  request.mockRejectedValueOnce(new Error("transport failed"));
  emitCatalogChanged();
  await vi.waitFor(() => {
    const container = draw();
    expect(find("model-select", "true")?.getAttribute("aria-busy")).toBe("false");
    expect(container.textContent).toContain("No models available");
  });
  expect(blocked()).toContain("Authentication failed");
  request.mockResolvedValueOnce({
    models: [{ ...model, available: true, unavailableReason: undefined }],
  });
  emitCatalogChanged();
  await vi.waitFor(() => expect(blocked()).toBeUndefined());
  release();
});

it("retires a control immediately and gives its remount a fresh result", async () => {
  const models = [testModel("openai", "gpt-5.6-luna", { name: "GPT-5.6 Luna" })];
  const pending = deferred<{ models: ModelCatalogEntry[] }>();
  const { context, request } = contextWith([]);
  request.mockImplementationOnce(() => pending.promise);
  const firstControl = managed.make(() => undefined);
  firstControl.load(context, "main", true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

  firstControl.reset();
  request.mockResolvedValueOnce({ models });
  const remountedControl = managed.make(() => undefined);
  remountedControl.load(context, "main", true);
  expect(request).toHaveBeenCalledTimes(2);
  pending.resolve({ models: [] });

  await vi.waitFor(() => {
    const container = renderControl(remountedControl, context);
    expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
    expect(modelOption(container, "openai/gpt-5.6-luna")).not.toBeNull();
  });
  expect(request).toHaveBeenCalledTimes(2);
});
describe("model selection policy", () => {
  const models = [testModel("fixture", "permitted", { name: "Permitted model", available: true })];
  const restricted: ModelCatalogResult = {
    models,
    modelSelectionPolicy: { restricted: true, defaultModel: "fixture/permitted" },
  };
  const agent = { id: "main", model: { primary: "fixture/forbidden-default" } };
  const scope = { agentId: "main", timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS };

  it("requires a permitted choice when URL intent is forbidden and policy has no default", async () => {
    const { context, request, control, draw, blocked } = setupModel(models, agent);
    const wire = deferred<ModelCatalogResult>();
    request.mockReturnValue(wire.promise);

    control.load(context, "main", true, {
      agent,
      initialModel: "fixture/forbidden",
    });
    expect(control.modelForSubmission()).toBe("");
    wire.resolve({ models, modelSelectionPolicy: { restricted: true, defaultModel: null } });
    await control.metadataRead;
    expect(control.modelForSubmission()).toBe("");
    const container = draw();
    expect(container.textContent).not.toContain("forbidden");
    expect(control.resolveAgentRuntime()).toBeUndefined();
    expect(blocked()).toBe("Choose a model");
    modelOption(container, "fixture/permitted")?.click();
    expect(blocked()).toBeUndefined();
  });

  it.each([
    { event: "config.changed" as const, payload: {}, clearsChoices: false },
    {
      event: "chat.metadata.changed" as const,
      payload: { modelSelectionChanged: true },
      clearsChoices: true,
    },
  ])(
    "handles $event while replacement fails (clears: $clearsChoices)",
    async ({ event, payload, clearsChoices }) => {
      const { request, emitCatalogChanged, control, draw, find, load, blocked } = setupModel(
        models,
        agent,
      );
      load();
      await control.metadataRead;
      for (const attempt of [0, 1]) {
        const wire = deferred<ModelCatalogResult>();
        request.mockReturnValueOnce(wire.promise);
        emitCatalogChanged(event, payload);
        const checking = draw();
        expect(Boolean(find("model-option"))).toBe(!clearsChoices);
        if (clearsChoices) {
          expect(checking.textContent).not.toContain("forbidden-default");
        }
        if (attempt === 1) {
          expect(checking.querySelector('[data-chat-model-catalog-state="error"]')).toBeNull();
          expect(checking.querySelector(".btn__spinner")).not.toBeNull();
        }
        if (clearsChoices) {
          expect(blocked()).toBe("Loading models…");
        }
        wire.reject(new Error("Catalog unavailable"));
        await expect(control.metadataRead).rejects.toThrow("Catalog unavailable");
        expect(find("model-catalog-state", "error")).not.toBeNull();
        expect(Boolean(find("model-option"))).toBe(!clearsChoices);
        expect(blocked()).toBe(clearsChoices ? "Models unavailable" : undefined);
      }
    },
  );

  it.each(["policy", "error"] as const)(
    "withholds retained selection and default across a new connection until its first receipt (%s)",
    async (outcome) => {
      const previous = testModel("fixture", "previous", {
        name: "Previous model",
        available: true,
      });
      const first = contextWith([previous]);
      const next = setupModel(models, agent);
      const wire = deferred<ModelCatalogResult>();
      next.request.mockReturnValue(wire.promise);
      const { control, blocked, model, draw, find } = next;
      try {
        control.load(first.context, "main", true, {
          agent,
          preference: { model: "fixture/previous" },
        });
        await control.metadataRead;
        expect(
          modelOption(renderControl(control, first.context, "main", agent), "fixture/previous"),
        ).not.toBeNull();

        control.load(next.context, "main", true, { agent });
        const pending = control.metadataRead;
        expect(model()).toBe("fixture/previous");
        expect(blocked()).toBe("Loading models…");
        const waiting = draw();
        expect(waiting.textContent).not.toContain("previous");
        expect(waiting.textContent).not.toContain("Previous model");
        expect(waiting.textContent).not.toContain("forbidden-default");
        expect(waiting.querySelector("[data-chat-model-option]")).toBeNull();

        if (outcome === "error") {
          wire.reject(new Error("Catalog unavailable"));
          await expect(pending).rejects.toThrow("Catalog unavailable");
          expect(blocked()).toBe("Models unavailable");
        } else {
          wire.resolve(restricted);
          await pending;
          expect(model()).toBe("");
          expect(blocked()).toBeUndefined();
          expect(find("model-option", "fixture/permitted")).not.toBeNull();
        }
        expect(draw().textContent).not.toContain("previous");
      } finally {
        wire.resolve(restricted);
        control.reset();
      }
    },
  );
  it.each([
    { storage: "browser", identified: false },
    { storage: "identity", identified: true },
  ])(
    "preserves saved model preferences across a restricted policy mask ($storage)",
    async ({ identified }) => {
      const saved = {
        model: "fixture/excluded",
        agentRuntime: "openclaw",
        thinkingLevel: "high",
        fastMode: true,
      };
      const { model, ...savedControls } = saved;
      const savedModel = testModel("fixture", "excluded", {
        available: true,
        agentRuntime: { id: "openclaw", source: "model" },
        reasoning: true,
        thinkingLevels: thinkingLevels(["high"], true),
        supportsFastMode: true,
      });
      let catalog: ModelCatalogResult = { models: [...models, savedModel] };
      const prefs = identityPreferences(identified, async () => catalog);
      const first = prefs.make();
      const drafts = [first];
      onTestFinished(() =>
        drafts.forEach((draft) => {
          draft.place.modelControl.reset();
          disposeWorktreeDraft(draft);
        }),
      );
      const client = first.context.gateway.snapshot.client!;
      const control = first.place.modelControl;
      const browserBytes = () =>
        Object.fromEntries(
          Array.from({ length: localStorage.length }, (_, index) => {
            const key = localStorage.key(index)!;
            return [key, localStorage.getItem(key)];
          }),
        );
      // This owner promise includes identity hydration and its initial browser mirror.
      await first.gateway.persistPreference("main", "/repo", saved);
      await loadModelCatalog(client, scope);
      control.reset();
      first.place.adoptAgentDefaults();
      expect(control).toMatchObject({ ...savedControls, selected: model });
      const stored = structuredClone(prefs.stored());
      expect(stored).toMatchObject(saved);
      const browser = browserBytes();
      const writes = vi.spyOn(first.gateway, "persistPreference");

      catalog = restricted;
      control.invalidate();
      await loadModelCatalog(client, scope);
      first.place.adoptAgentDefaults();
      // Adopt uses the accepted cached receipt; join any real queued writer it started.
      for (const result of writes.mock.results) {
        await result.value;
      }
      expect(control).toMatchObject({
        selected: "",
        agentRuntime: undefined,
        thinkingLevel: "",
        fastMode: undefined,
      });
      expect(prefs.stored()).toEqual(stored);
      expect(browserBytes()).toEqual(browser);
      expect(writes).not.toHaveBeenCalled();

      catalog = { ...restricted, models: [...models, savedModel] };
      control.invalidate();
      await loadModelCatalog(client, scope);
      const next = prefs.make(first.context.gateway);
      drafts.push(next);
      expect(next.place.modelControl).toMatchObject({ ...savedControls, selected: model });
      expect(prefs.stored()).toEqual(stored);

      const repairs = vi.spyOn(next.gateway, "persistPreference");
      first.request.mockClear();
      catalog = { models };
      next.place.modelControl.invalidate();
      await loadModelCatalog(client, scope);
      next.place.adoptAgentDefaults();
      for (const result of repairs.mock.results) {
        await result.value;
      }
      if (identified) {
        expect(prefs.stored()).toMatchObject({
          model: "",
          agentRuntime: "",
          thinkingLevel: "",
          fastMode: undefined,
        });
      }
      for (const field of ["model", "agentRuntime", "thinkingLevel", "fastMode"]) {
        if (!identified) {
          expect(prefs.stored()).not.toHaveProperty(field);
        }
        expect(loadNewSessionPreference("ws://gateway.example", "main")).not.toHaveProperty(field);
      }
      expect(first.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(
        identified,
      );
      expect(repairs).toHaveBeenCalled();
    },
  );
});
