import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import { contextWith, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { loadNewSessionPreference } from "./preferences.ts";

function retainedAccountDraft() {
  const model: ModelCatalogEntry = {
    id: "model",
    name: "Model",
    provider: "anthropic",
    available: false,
    unavailableReason: "missing-auth",
  };
  const account = {
    authProfileId: "personal:person-a:anthropic:one",
    provider: "anthropic",
    label: "Saved account A1",
    authType: "token",
    selected: false,
  };
  const agent = { id: "main", model: { primary: "anthropic/model" } };
  const { context, request } = contextWith([model]);
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
  const savePreference = vi.fn();
  const control = new NewSessionModelControl(() => undefined, savePreference);
  control.load(context, "main", true, { agent });
  const draw = (id = "main") => renderControl(control, context, id, { ...agent, id });
  const select = (value: string) =>
    draw().querySelector<HTMLButtonElement>(`[data-chat-account-option="${value}"]`)!.click();
  const chooseAccount = async () => {
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    const picker = draw().querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]");
    expect(picker).not.toBeNull();
    picker!.click();
    await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
    select(`account:${account.authProfileId}`);
    return {
      completion: vi.waitFor(() =>
        expect(control.modelSelectionBlockedReason(agent)).not.toBe("Loading models…"),
      ),
    };
  };
  return {
    account,
    agent,
    context,
    control,
    request,
    preview,
    connected,
    neutral,
    draw,
    select,
    chooseAccount,
    savePreference,
  };
}

describe("new-session model metadata lifecycle", () => {
  it("retires a consumed personal-account model before the next configured draft", async () => {
    const { context, control, neutral, connected, preview, draw, chooseAccount } =
      retainedAccountDraft();
    Object.assign(context, { config: { current: { newSessionModelDefaults: "configured" } } });
    const alternate = {
      id: "alternate",
      name: "Alternate",
      provider: "anthropic",
      available: true,
    };
    neutral.models.push(alternate);
    connected.models.push(alternate);
    const { completion } = await chooseAccount();
    preview.resolve(connected);
    await completion;
    draw()
      .querySelector<HTMLButtonElement>('[data-chat-model-option="anthropic/alternate"]')!
      .click();
    expect(control.modelForSubmission()).toContain("anthropic/alternate@");
    control.retireDraftSelection();
    expect(control.modelForSubmission()).toBe("");
    expect(draw().querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
      "Automatic",
    );
    control.reset();
  });

  it("keeps a deliberate provider switch when leaving a personal account for a cached catalog", async () => {
    const {
      context,
      control,
      request,
      neutral,
      connected,
      preview,
      draw,
      chooseAccount,
      savePreference,
    } = retainedAccountDraft();
    Object.assign(context, { config: { current: { newSessionModelDefaults: "configured" } } });
    const other = { id: "other", name: "Other provider", provider: "openai", available: true };
    neutral.models.push(other);
    connected.models.push(other);
    const { completion } = await chooseAccount();
    preview.resolve(connected);
    await completion;
    expect(control.accountSelectionReady()).toBe(true);
    const reads = request.mock.calls.filter(([method]) => method === "models.list").length;
    draw().querySelector<HTMLButtonElement>('[data-chat-model-option="openai/other"]')!.click();
    expect(control.modelForSubmission()).toBe("openai/other");
    expect(savePreference).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "openai/other" }),
    );
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(reads);
    control.reset();
  });

  it.each(["empty", "rejection"])(
    "displays invalidated models on remount without restoring preferences before %s",
    async (outcome) => {
      const models: ModelCatalogEntry[] = ["first", "second"].map((id) => ({
        id,
        name: id,
        provider: "fixture",
        available: true,
        agentRuntime: { id: "sample-runtime", cloudPlacementSupported: false, source: "model" },
      }));
      const agent: GatewayAgentRow = {
        id: "main",
        model: { primary: "fixture/first" },
        agentRuntime: { id: "sample-runtime", cloudPlacementSupported: true, source: "agent" },
      };
      const { context, request } = contextWith(models);
      const firstControl = new NewSessionModelControl(() => undefined);
      const draw = (control: NewSessionModelControl) =>
        renderControl(control, context, "main", agent);
      firstControl.load(context, "main", true, { agent });
      await vi.waitFor(() => expect(draw(firstControl).textContent).toContain("second"));
      expect(firstControl.resolveAgentRuntime({ agent, context })?.cloudPlacementSupported).toBe(
        false,
      );
      firstControl.reset();
      invalidateModelCatalogCache(context.gateway.snapshot.client!, { agentId: "main" });
      const replacement = deferred<ModelCatalogResult>();
      request.mockReturnValueOnce(replacement.promise);
      const savePreference = vi.fn();
      const remounted = new NewSessionModelControl(() => undefined, savePreference);
      const preference = { model: "fixture/remembered", thinkingLevel: "high" };
      try {
        remounted.load(context, "main", true, { agent, preference });
        expect(
          draw(remounted).querySelector('[data-chat-model-option="fixture/first"]'),
        ).not.toBeNull();
        expect(
          draw(remounted).querySelector('[data-chat-model-option="fixture/second"]'),
        ).not.toBeNull();
        expect(remounted.isRestoringPreference()).toBe(true);
        expect(remounted.selected).toBe("");
        expect(remounted.resolveAgentRuntime({ agent, context })?.cloudPlacementSupported).toBe(
          true,
        );
        expect(savePreference).not.toHaveBeenCalled();
        remounted.load(context, "main", true, { agent, preference });
        expect(savePreference).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        if (outcome === "rejection") {
          replacement.reject(new Error("Catalog unavailable"));
        } else {
          replacement.resolve({
            models: [],
          });
        }
        await vi.waitFor(() => expect(remounted.isRestoringPreference()).toBe(false));
        const container = draw(remounted);
        expect(container.querySelector('[data-chat-model-option="fixture/second"]') !== null).toBe(
          outcome === "rejection",
        );
        if (outcome === "rejection") {
          expect(savePreference).not.toHaveBeenCalled();
          expect(remounted.selected).toBe(preference.model);
          expect(remounted.thinkingLevel).toBe(preference.thinkingLevel);
          container
            .querySelector<HTMLButtonElement>('[data-chat-model-option="fixture/second"]')
            ?.click();
          expect(remounted.selected).toBe("fixture/second");
          expect(remounted.resolveAgentRuntime({ agent, context })?.cloudPlacementSupported).toBe(
            false,
          );
        } else {
          expect(remounted.resolveAgentRuntime({ agent, context })?.cloudPlacementSupported).toBe(
            true,
          );
        }
        expect(request.mock.calls.every(([method]) => method === "models.list")).toBe(true);
      } finally {
        remounted.reset();
      }
    },
  );

  it("does not complete a retained account preview before its replacement is accepted", async () => {
    const {
      account,
      agent,
      context,
      control,
      request,
      preview,
      connected,
      chooseAccount,
      select,
      draw,
      savePreference,
    } = retainedAccountDraft();
    const { completion } = await chooseAccount();
    preview.resolve(connected);
    await completion;
    select("automatic");
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    invalidateModelCatalogCache(context.gateway.snapshot.client!, {
      agentId: "main",
      authProfileId: account.authProfileId,
    });
    const replacement = deferred<ModelCatalogResult>();
    request.mockImplementation((method: string) =>
      method === "models.list"
        ? replacement.promise
        : Promise.resolve({ profileId: "person-a", accounts: [account], links: [] }),
    );
    try {
      draw().querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")!.click();
      await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
      select(`account:${account.authProfileId}`);
      expect(draw().querySelector('[data-chat-model-option="anthropic/model"]')).not.toBeNull();
      expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
      expect(control.accountSelectionReady()).toBe(false);
      expect(
        draw()
          .querySelector("[data-chat-account-selection]")
          ?.getAttribute("data-chat-account-selection"),
      ).toBe("automatic");
      expect(savePreference).not.toHaveBeenCalled();
      replacement.resolve(connected);
      await vi.waitFor(() => expect(control.accountSelectionReady()).toBe(true));
      expect(savePreference).not.toHaveBeenCalled();
    } finally {
      control.reset();
    }
  });

  it.each(["agent", "client", "identity", "handshake", "disconnect"])(
    "clears retained display and fences its late replacement after changing %s",
    async (change) => {
      const model = { provider: "fixture", id: "retained", name: "Retained", available: true };
      const agent = { id: "main", model: { primary: "fixture/retained" } };
      const { context, request } = contextWith([model]);
      const first = new NewSessionModelControl(() => undefined);
      first.load(context, "main", true, { agent });
      await vi.waitFor(() =>
        expect(renderControl(first, context).textContent).toContain("Retained"),
      );
      first.reset();
      invalidateModelCatalogCache(context.gateway.snapshot.client!, { agentId: "main" });
      const retired = deferred<ModelCatalogResult>();
      const current = deferred<ModelCatalogResult>();
      request.mockReturnValueOnce(retired.promise).mockReturnValue(current.promise);
      const control = new NewSessionModelControl(() => undefined);
      let agentId = "main";
      const draw = () => renderControl(control, context, agentId, { ...agent, id: agentId });
      try {
        control.load(context, agentId, true, { agent });
        expect(draw().querySelector('[data-chat-model-option="fixture/retained"]')).not.toBeNull();
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        const previous = { ...context.gateway.snapshot };
        if (change === "agent") {
          agentId = "research";
        } else if (change === "client") {
          Object.assign(context.gateway.snapshot, {
            client: createTestGatewayClient(() => current.promise),
          });
        } else if (change === "identity") {
          Object.assign(context.gateway.snapshot, {
            selfUser: { id: "person-b", name: "Person B" },
          });
        } else if (change === "handshake") {
          Object.assign(context.gateway.snapshot, { hello: { ...previous.hello } });
        } else {
          Object.assign(context.gateway.snapshot, { phase: "offline" });
        }
        createGatewayMetadataObserver(() => true).synchronize(previous, context.gateway.snapshot);
        control.load(context, agentId, true, { agent: { ...agent, id: agentId } });
        expect(draw().querySelector('[data-chat-model-option="fixture/retained"]')).toBeNull();
        current.resolve({ models: [{ ...model, id: "current", name: "Current" }] });
        if (change === "agent" || change === "client") {
          await vi.waitFor(() =>
            expect(
              draw().querySelector('[data-chat-model-option="fixture/current"]'),
            ).not.toBeNull(),
          );
        }
        retired.resolve({ models: [{ ...model, id: "late", name: "Late" }] });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        if (change === "disconnect") {
          expect(draw().querySelector('[data-chat-model-option="fixture/current"]')).toBeNull();
        } else {
          await vi.waitFor(() =>
            expect(
              draw().querySelector('[data-chat-model-option="fixture/current"]'),
            ).not.toBeNull(),
          );
        }
        expect(draw().querySelector('[data-chat-model-option="fixture/late"]')).toBeNull();
      } finally {
        control.reset();
      }
    },
  );

  it("enables a cooled-down model on reopen without a catalog event", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "example",
      available: false,
      unavailableReason: "cooldown",
      unavailableUntil: 12_000,
    };
    const agent = { id: "main", model: { primary: "example/model" } };
    const { context, request } = contextWith([model]);
    const control = new NewSessionModelControl(() => undefined);
    const option = () =>
      renderControl(control, context, "main", agent).querySelector<HTMLButtonElement>(
        '[data-chat-model-option="example/model"]',
      );
    try {
      control.load(context, "main", true, { agent });
      await vi.waitFor(() => expect(option()?.disabled).toBe(true));
      request.mockResolvedValueOnce({
        models: [
          { ...model, available: true, unavailableReason: undefined, unavailableUntil: undefined },
        ],
      });
      clock.mockReturnValue(12_000);
      renderControl(control, context, "main", agent)
        .querySelector<HTMLElement>('[data-chat-model-select="true"]')!
        .click();
      await vi.waitFor(() => expect(option()?.disabled).toBe(false));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      control.reset();
      clock.mockRestore();
    }
  });

  it("selects a usable retained account after refresh failure without changing saved preferences", async () => {
    const {
      account,
      agent,
      control,
      request,
      preview,
      connected,
      draw,
      select,
      chooseAccount,
      savePreference,
    } = retainedAccountDraft();
    const { completion } = await chooseAccount();
    expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "models.list",
      { view: "configured", agentId: "main", authProfileId: account.authProfileId },
    ]);
    expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
    preview.resolve({ ...connected, refreshFailed: true });
    await completion;
    expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
    expect(control.accountSelectionReady()).toBe(true);
    expect(draw().querySelector("[data-chat-model-catalog-state]")).toBeNull();
    expect(draw().querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
      account.label,
    );
    expect(control.modelForSubmission()).toBe(`anthropic/model@${account.authProfileId}`);
    expect(control.selected).toBe("");
    select("automatic");
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    expect(control.modelForSubmission()).toBe("");
    expect(draw().querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
      "Automatic",
    );
    expect(savePreference).not.toHaveBeenCalled();
    expect(
      request.mock.calls.some(([method]) => /users\.(selectModelAccount|prefs\.set)/.test(method)),
    ).toBe(false);
    control.reset();
  });

  it.each(["unconfirmed account", "unknown availability"])(
    "keeps an explicit account blocked after a preview with $0",
    async (outcome) => {
      const { agent, control, preview, connected, chooseAccount } = retainedAccountDraft();
      const { completion } = await chooseAccount();
      expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
      preview.resolve({
        ...connected,
        ...(outcome === "unconfirmed account" ? { accountSelection: undefined } : {}),
        ...(outcome === "unknown availability"
          ? {
              models: connected.models?.map((model) =>
                Object.assign({}, model, { available: undefined }),
              ),
            }
          : {}),
      });
      await completion;
      expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable");
      control.reset();
    },
  );

  it("retires a pending personal-account preview when the user identity changes", async () => {
    const { agent, context, control, preview, connected, chooseAccount, draw } =
      retainedAccountDraft();
    const { completion } = await chooseAccount();
    Object.assign(context.gateway.snapshot, { selfUser: { id: "person-b", name: "Person B" } });
    control.load(context, "main", true, { agent });
    preview.resolve(connected);
    await completion;
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    expect(control.modelForSubmission()).toBe("");
    expect(draw().querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
      "Automatic",
    );
    control.reset();
  });

  it("retains draft model controls across client replacement but clears them for another agent", async () => {
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "openai",
      available: true,
    };
    const agent = { id: "main", model: { primary: "openai/model" } };
    const first = contextWith([model]);
    const control = new NewSessionModelControl(() => undefined);
    control.load(first.context, "main", true, { agent });
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledOnce());
    const selection = {
      selected: "openai/model",
      contextWindow: "200k",
      thinkingLevel: "high",
      fastMode: true,
    } as const;
    Object.assign(control, selection);
    const replacement = contextWith([
      { ...model, available: false, unavailableReason: "missing-auth" },
    ]);

    control.load(replacement.context, "main", true, { agent });
    expect(control).toMatchObject(selection);
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    expect(control).toMatchObject(selection);

    control.load(replacement.context, "research", true);
    expect(control).toMatchObject({
      selected: "",
      contextWindow: "",
      thinkingLevel: "",
      fastMode: undefined,
    });
    control.reset();
  });

  it("retains its neutral auth gate through pending, rejected and failed refreshes, isolated from a session projection", async () => {
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "test",
      available: false,
      unavailableReason: "missing-auth",
    };
    const agent = { id: "main", model: { primary: "test/model" } };
    const { context, request, emitCatalogChanged } = contextWith([model]);
    const client = context.gateway.snapshot.client!;
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    const scope = { agentId: "main", sessionKey: "agent:main:locked" };
    const release = subscribeChatMetadata(client, scope, () => {});
    beginChatMetadataPublication(client, scope).publish({
      commands: [],
      models: [{ ...model, available: true, unavailableReason: undefined }],
    });
    expect(control.modelUnavailableReason(agent)).toBe("missing-auth");
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    request.mockReturnValueOnce(pending.promise);
    emitCatalogChanged();
    expect(control.modelUnavailableReason(agent)).toBe("missing-auth");
    pending.resolve({ models: [{ ...model, unavailableReason: "auth-failed" }] });
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("auth-failed"));
    request.mockRejectedValueOnce(new Error("transport failed"));
    emitCatalogChanged();
    await vi.waitFor(() => {
      const container = renderControl(control, context, "main", agent);
      expect(
        container.querySelector('[data-chat-model-select="true"]')?.getAttribute("aria-busy"),
      ).toBe("false");
      expect(container.textContent).toContain("No models available");
    });
    expect(control.modelUnavailableReason(agent)).toBe("auth-failed");
    request.mockResolvedValueOnce({
      models: [{ ...model, available: true, unavailableReason: undefined }],
    });
    emitCatalogChanged();
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBeUndefined());
    release();
    control.reset();
  });

  it("retires a control immediately and gives its remount a fresh result after pending work finishes", async () => {
    const models: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    ];
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request.mockImplementationOnce(() => pending.promise);
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    firstControl.reset();
    request.mockResolvedValueOnce({ models });
    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true);
    expect(request).toHaveBeenCalledOnce();
    pending.resolve({ models: [] });

    await vi.waitFor(() => {
      const container = renderControl(remountedControl, context);
      expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
      expect(
        container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
      ).not.toBeNull();
    });
    expect(request).toHaveBeenCalledTimes(2);
    remountedControl.reset();
  });
});

describe("model selection policy", () => {
  const models = [
    { id: "permitted", name: "Permitted model", provider: "fixture", available: true },
  ];
  const restricted: ModelCatalogResult = {
    models,
    modelSelectionPolicy: { restricted: true, defaultModel: "fixture/permitted" },
  };
  const agent = { id: "main", model: { primary: "fixture/forbidden-default" } };
  const scope = { agentId: "main", timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS };

  describe("New Session policy presentation", () => {
    it("requires a permitted choice when URL intent is forbidden and policy has no default", async () => {
      const { context, request } = contextWith(models);
      const wire = deferred<ModelCatalogResult>();
      request.mockReturnValue(wire.promise);
      const ready = deferred();
      const control = new NewSessionModelControl(() => {
        if (
          renderControl(control, context, "main", agent).querySelector(
            '[data-chat-model-option="fixture/permitted"]',
          )
        ) {
          ready.resolve();
        }
      });
      try {
        control.load(context, "main", true, {
          agent,
          initialModel: "fixture/forbidden",
        });
        expect(control.modelForSubmission()).toBe("");
        const published = loadModelCatalog(context.gateway.snapshot.client!, scope);
        wire.resolve({ models, modelSelectionPolicy: { restricted: true, defaultModel: null } });
        await published;
        await ready.promise;
        expect(control.modelForSubmission()).toBe("");
        const container = renderControl(control, context, "main", agent);
        expect(container.textContent).not.toContain("forbidden");
        expect(control.resolveAgentRuntime()).toBeUndefined();
        expect(control.modelSelectionBlockedReason(agent)).toBe("Choose a model");
        container
          .querySelector<HTMLButtonElement>('[data-chat-model-option="fixture/permitted"]')
          ?.click();
        expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
      } finally {
        control.reset();
      }
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
        const { context, request, emitCatalogChanged } = contextWith(models);
        const ready = deferred();
        let failed = deferred();
        const control = new NewSessionModelControl(() => {
          const container = renderControl(control, context, "main", agent);
          if (container.querySelector('[data-chat-model-option="fixture/permitted"]')) {
            ready.resolve();
          }
          if (container.querySelector('[data-chat-model-catalog-state="error"]')) {
            failed.resolve();
          }
        });
        try {
          control.load(context, "main", true, { agent });
          await loadModelCatalog(context.gateway.snapshot.client!, scope);
          await ready.promise;
          expect(
            renderControl(control, context, "main", agent).querySelector(
              "[data-chat-model-option]",
            ),
          ).not.toBeNull();
          const wire = deferred<ModelCatalogResult>();
          request.mockReturnValueOnce(wire.promise);
          emitCatalogChanged(event, payload);
          const container = renderControl(control, context, "main", agent);
          expect(Boolean(container.querySelector("[data-chat-model-option]"))).toBe(!clearsChoices);
          if (clearsChoices) {
            expect(container.textContent).not.toContain("forbidden-default");
            expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
          }
          const published = loadModelCatalog(context.gateway.snapshot.client!, scope);
          wire.reject(new Error("Catalog unavailable"));
          await expect(published).rejects.toThrow("Catalog unavailable");
          await failed.promise;
          expect(
            Boolean(
              renderControl(control, context, "main", agent).querySelector(
                "[data-chat-model-option]",
              ),
            ),
          ).toBe(!clearsChoices);
          expect(control.modelSelectionBlockedReason(agent)).toBe(
            clearsChoices ? "Models unavailable" : undefined,
          );

          failed = deferred();
          const replacement = deferred<ModelCatalogResult>();
          request.mockReturnValueOnce(replacement.promise);
          emitCatalogChanged(event, payload);
          const checking = renderControl(control, context, "main", agent);
          expect(checking.querySelector('[data-chat-model-catalog-state="error"]')).toBeNull();
          expect(checking.querySelector(".btn__spinner")).not.toBeNull();
          if (clearsChoices) {
            expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
          } else {
            expect(
              checking.querySelector('[data-chat-model-option="fixture/permitted"]'),
            ).not.toBeNull();
          }
          const rechecked = loadModelCatalog(context.gateway.snapshot.client!, scope);
          replacement.reject(new Error("Catalog still unavailable"));
          await expect(rechecked).rejects.toThrow("Catalog still unavailable");
          await failed.promise;
          expect(
            renderControl(control, context, "main", agent).querySelector(
              '[data-chat-model-catalog-state="error"]',
            ),
          ).not.toBeNull();
          expect(control.modelSelectionBlockedReason(agent)).toBe(
            clearsChoices ? "Models unavailable" : undefined,
          );
        } finally {
          control.reset();
        }
      },
    );

    it.each(["policy", "error"] as const)(
      "withholds retained selection and default across a new connection until its first receipt (%s)",
      async (outcome) => {
        const previous = {
          id: "previous",
          name: "Previous model",
          provider: "fixture",
          available: true,
        };
        const first = contextWith([previous]);
        const next = contextWith(models);
        const wire = deferred<ModelCatalogResult>();
        next.request.mockReturnValue(wire.promise);
        const initialPublished = deferred();
        const nextPublished = deferred();
        let nextActive = false;
        const control = new NewSessionModelControl(() => {
          if (!nextActive && control.modelForSubmission() === "fixture/previous") {
            initialPublished.resolve();
          }
          if (
            nextActive &&
            (outcome === "error"
              ? control.modelSelectionBlockedReason(agent) === "Models unavailable"
              : control.modelForSubmission() === "" &&
                control.modelSelectionBlockedReason(agent) === undefined)
          ) {
            nextPublished.resolve();
          }
        });
        try {
          control.load(first.context, "main", true, {
            agent,
            preference: { model: "fixture/previous" },
          });
          await loadModelCatalog(first.context.gateway.snapshot.client!, scope);
          await initialPublished.promise;
          expect(control.modelForSubmission()).toBe("fixture/previous");
          expect(
            renderControl(control, first.context, "main", agent).querySelector(
              '[data-chat-model-option="fixture/previous"]',
            ),
          ).not.toBeNull();

          nextActive = true;
          control.load(next.context, "main", true, { agent });
          const pending = loadModelCatalog(next.context.gateway.snapshot.client!, scope);
          expect(control.modelForSubmission()).toBe("fixture/previous");
          expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
          const waiting = renderControl(control, next.context, "main", agent);
          expect(waiting.textContent).not.toContain("previous");
          expect(waiting.textContent).not.toContain("Previous model");
          expect(waiting.textContent).not.toContain("forbidden-default");
          expect(waiting.querySelector("[data-chat-model-option]")).toBeNull();

          if (outcome === "error") {
            wire.reject(new Error("Catalog unavailable"));
            await expect(pending).rejects.toThrow("Catalog unavailable");
            await nextPublished.promise;
            expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable");
            expect(renderControl(control, next.context, "main", agent).textContent).not.toContain(
              "previous",
            );
          } else {
            wire.resolve(restricted);
            await pending;
            await nextPublished.promise;
            expect(control.modelForSubmission()).toBe("");
            expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
            const confirmed = renderControl(control, next.context, "main", agent);
            expect(
              confirmed.querySelector('[data-chat-model-option="fixture/permitted"]'),
            ).not.toBeNull();
            expect(confirmed.textContent).not.toContain("previous");
          }
        } finally {
          wire.resolve(restricted);
          control.reset();
        }
      },
    );
  });

  describe("New Session stored model preference policy", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      localStorage.clear();
      sessionStorage.clear();
    });

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
        const savedModel: ModelCatalogEntry = {
          id: "excluded",
          provider: "fixture",
          name: "Saved model",
          available: true,
          agentRuntime: { id: "openclaw", source: "model" },
          reasoning: true,
          thinkingLevels: [{ id: "high", label: "High" }],
          supportsFastMode: true,
        };
        let catalog: ModelCatalogResult = { models: [...models, savedModel] };
        const prefs = identityPreferences(identified, async () => catalog);
        const first = prefs.make();
        const drafts = [first];
        const client = first.context.gateway.snapshot.client!;
        const control = first.place.modelControl;
        const browserBytes = () => {
          const entries: Record<string, string | null> = {};
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key !== null) {
              entries[key] = localStorage.getItem(key);
            }
          }
          return entries;
        };
        try {
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
          first.request.mockClear();

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
          expect(
            first.request.mock.calls.filter(([method]) => method === "users.prefs.set"),
          ).toEqual([]);
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
            expect(loadNewSessionPreference("ws://gateway.example", "main")).not.toHaveProperty(
              field,
            );
          }
          expect(first.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(
            identified,
          );
          expect(repairs).toHaveBeenCalled();
        } finally {
          for (const draft of drafts) {
            draft.place.modelControl.reset();
            draft.gateway.disconnect();
            draft.place.browser.disconnect();
            draft.flow.disconnect();
          }
        }
      },
    );
  });
});
