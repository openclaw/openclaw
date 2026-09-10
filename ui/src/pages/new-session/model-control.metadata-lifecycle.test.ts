import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import {
  beginChatMetadataPublication,
  subscribeChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { contextWith, deferred, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

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
    draw()
      .querySelector(".chat-model-account__picker")!
      .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } } }));
  const chooseAccount = async () => {
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
    const picker = draw().querySelector(".chat-model-account__picker");
    expect(picker).not.toBeNull();
    picker!.dispatchEvent(new Event("wa-show"));
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
  it.each([false, true])(
    "selects a usable retained account with refresh warning %s without changing saved preferences",
    async (refreshFailed) => {
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
      expect(request).toHaveBeenLastCalledWith(
        "models.list",
        { view: "configured", agentId: "main", authProfileId: account.authProfileId },
        { signal: expect.any(AbortSignal) },
      );
      expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
      preview.resolve({ ...connected, refreshFailed });
      await completion;
      expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
      expect(control.accountSelectionReady()).toBe(true);
      expect(draw().textContent?.includes("Some models could not be refreshed.")).toBe(
        refreshFailed,
      );
      expect(draw().querySelector("[data-chat-account-trigger]")?.textContent).toContain(
        account.label,
      );
      expect(control.modelForSubmission()).toBe(`anthropic/model@${account.authProfileId}`);
      expect(control.selected).toBe("");
      select("automatic");
      await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
      expect(control.modelForSubmission()).toBe("");
      expect(draw().querySelector("[data-chat-account-trigger]")?.textContent).toContain(
        "Automatic",
      );
      expect(savePreference).not.toHaveBeenCalled();
      expect(
        request.mock.calls.some(([method]) =>
          /users\.(selectModelAccount|prefs\.set)/.test(method),
        ),
      ).toBe(false);
      control.reset();
    },
  );

  it("retries the same draft account after failed previews and accepts its successful result", async () => {
    const { account, agent, control, request, preview, connected, draw, select, chooseAccount } =
      retainedAccountDraft();
    const { completion } = await chooseAccount();
    preview.reject(new Error("Preview unavailable"));
    await completion;
    expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable");
    expect(control.accountSelectionReady()).toBe(false);

    draw().querySelector(".chat-model-account__picker")!.dispatchEvent(new Event("wa-show"));
    await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
    const failedRetry = deferred<ModelCatalogResult>();
    request.mockReturnValueOnce(failedRetry.promise);
    select(`account:${account.authProfileId}`);
    expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
    failedRetry.reject(new Error("Preview still unavailable"));
    await vi.waitFor(() =>
      expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable"),
    );
    expect(control.accountSelectionReady()).toBe(false);

    draw().querySelector(".chat-model-account__picker")!.dispatchEvent(new Event("wa-show"));
    await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
    request.mockResolvedValueOnce(connected);
    select(`account:${account.authProfileId}`);
    await vi.waitFor(() => expect(control.accountSelectionReady()).toBe(true));
    expect(control.modelSelectionBlockedReason(agent)).toBeUndefined();
    expect(draw().querySelector("[data-chat-account-trigger]")?.textContent).toContain(
      account.label,
    );
    expect(control.modelForSubmission()).toBe(`anthropic/model@${account.authProfileId}`);
    control.reset();
  });

  it.each(["request failure", "missing model", "unconfirmed account", "unknown availability"])(
    "keeps an explicit account blocked after a preview with $0",
    async (outcome) => {
      const { agent, control, preview, connected, chooseAccount } = retainedAccountDraft();
      const { completion } = await chooseAccount();
      expect(control.modelSelectionBlockedReason(agent)).toBe("Loading models…");
      if (outcome === "request failure") {
        preview.reject(new Error("Preview unavailable"));
      } else {
        preview.resolve({
          ...connected,
          ...(outcome === "missing model" ? { models: [] } : {}),
          ...(outcome === "unconfirmed account" ? { accountSelection: undefined } : {}),
          ...(outcome === "unknown availability"
            ? {
                models: connected.models?.map((model) =>
                  Object.assign({}, model, { available: undefined }),
                ),
              }
            : {}),
        });
      }
      await completion;
      expect(control.modelSelectionBlockedReason(agent)).toBe("Models unavailable");
      control.reset();
    },
  );

  it.each(["identity", "client", "agent", "Automatic", "reset"])(
    "retires the pending account preview after changing $0",
    async (change) => {
      const { agent, context, control, preview, connected, neutral, chooseAccount, select, draw } =
        retainedAccountDraft();
      const { completion } = await chooseAccount();
      let agentId = "main";
      if (change === "identity") {
        Object.assign(context.gateway.snapshot, { selfUser: { id: "person-b", name: "Person B" } });
      } else if (change === "client") {
        Object.assign(context.gateway.snapshot, {
          client: createTestGatewayClient(async () => neutral),
        });
      } else if (change === "agent") {
        agentId = "research";
      } else if (change === "Automatic") {
        select("automatic");
      } else {
        control.reset();
      }
      control.load(context, agentId, true, { agent: { ...agent, id: agentId } });
      preview.resolve(connected);
      await completion;
      await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBe("missing-auth"));
      expect(control.modelForSubmission()).toBe("");
      expect(draw(agentId).querySelector("[data-chat-account-trigger]")?.textContent).toContain(
        "Automatic",
      );
      control.reset();
    },
  );

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
    await vi.waitFor(() =>
      expect(renderControl(control, context, "main", agent).textContent).toContain(
        "Some models could not be refreshed.",
      ),
    );
    expect(control.modelUnavailableReason(agent)).toBe("auth-failed");
    request.mockResolvedValueOnce({
      models: [{ ...model, available: true, unavailableReason: undefined }],
    });
    emitCatalogChanged();
    await vi.waitFor(() => expect(control.modelUnavailableReason(agent)).toBeUndefined());
    release();
    control.reset();
  });

  it("reads published models when the picker opens without acquiring providers", async () => {
    const prepared = [{ id: "prepared", name: "Prepared", provider: "example" }];
    const published = [...prepared, { id: "published", name: "Published", provider: "example" }];
    const { context, request } = contextWith(prepared);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector(
          '[data-chat-model-option="example/prepared"]',
        ),
      ).not.toBeNull(),
    );
    request.mockResolvedValue({ models: published });
    const picker = renderControl(control, context).querySelector<HTMLDetailsElement>(
      ".chat-controls__model-picker",
    )!;
    picker.querySelector("summary")!.click();
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector(
          '[data-chat-model-option="example/published"]',
        ),
      ).not.toBeNull(),
    );
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["models.list", { view: "configured", agentId: "main" }],
      ["models.list", { view: "configured", agentId: "main" }],
    ]);
    control.reset();
  });

  it("reads current catalog state on remount after control teardown", async () => {
    const models: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
        unavailableReason: "missing-auth",
      },
    ];
    const agent = { id: "main", model: { primary: "openai/gpt-5.6-luna" } };
    const { context, request } = contextWith(models);
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true, { agent });
    await vi.waitFor(() => expect(firstControl.modelUnavailableReason(agent)).toBe("missing-auth"));
    firstControl.reset();

    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true, { agent });
    await vi.waitFor(() =>
      expect(remountedControl.modelUnavailableReason(agent)).toBe("missing-auth"),
    );

    const container = renderControl(remountedControl, context, "main", agent);
    expect(container.querySelector('[data-chat-model-catalog-state="ready"]')).not.toBeNull();
    expect(remountedControl.modelUnavailableReason(agent)).toBe("missing-auth");
    expect(
      container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("No models available");
    expect(request).toHaveBeenCalledTimes(2);
    remountedControl.reset();
  });

  it("aborts a retired control request and gives the remounted control its own result", async () => {
    const models: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    ];
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request.mockImplementationOnce((_method, _params, options?: { signal?: AbortSignal }) => {
      options?.signal?.addEventListener(
        "abort",
        () => pending.reject(new DOMException("metadata request aborted", "AbortError")),
        { once: true },
      );
      return pending.promise;
    });
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    firstControl.reset();
    request.mockResolvedValueOnce({ models });
    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true);
    pending.resolve({ models });

    await vi.waitFor(() => {
      const container = renderControl(remountedControl, context);
      expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
      expect(
        container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
      ).not.toBeNull();
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[2]?.signal.aborted).toBe(true);
    remountedControl.reset();
  });

  it("reapplies an updated preference against the attached ready snapshot", async () => {
    const models: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
        reasoning: true,
        thinkingLevels: [{ id: "high", label: "high" }],
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        reasoning: true,
        thinkingLevels: [{ id: "low", label: "low" }],
      },
    ];
    const refresh = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request, emitCatalogChanged } = contextWith(models);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-sol"));
    expect(control.thinkingLevel).toBe("high");
    request.mockReturnValueOnce(refresh.promise);
    emitCatalogChanged();

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-luna", thinkingLevel: "low" },
    });

    refresh.resolve({ models });
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-luna"));
    expect(control.thinkingLevel).toBe("low");
    expect(request).toHaveBeenCalledTimes(2);
    control.reset();
  });
});
