/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  UserModelAccount,
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStatusResult,
  UsersListAuthLinksResult,
  UsersListModelAccountsResult,
  WizardStep,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n, t } from "../../i18n/index.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { choosePickerValue } from "../../test-helpers/select-picker.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ModelAccountsTargetSource } from "./model-accounts-state.ts";
import { ModelAccounts } from "./model-accounts.tsx";

const copy = (key: string) => t(`profilePage.modelAccounts.${key}`);
const auth = (suffix: string) => `.profile-auth-${suffix}`;
const ui = {
  flow: ".model-accounts-flow",
  notice: ".model-accounts-notice",
  answer: ".wizard-step__form input",
  submit: '.wizard-step__form button[type="submit"]',
  password: 'input[type="password"]',
  alert: '[role="alert"]',
  host: "openclaw-model-accounts",
};

const connected: UsersAuthConnectStatusResult = {
  status: "connected",
  authProfileId: "openai:personal",
  links: [{ provider: "openai", authProfileId: "openai:personal", updatedAt: 1 }],
};

const personal: UserModelAccount = {
  authProfileId: "openai:personal",
  provider: "openai",
  label: "Ada · Personal workspace",
  authType: "oauth",
  selected: true,
};
const work = { ...personal, authProfileId: "openai:work", label: "Work", selected: false };
const catalog: UsersAuthConnectCatalogResult = {
  providers: [
    { id: "openai", label: "OpenAI", methods: [{ id: "browser", label: "Browser sign-in" }] },
    { id: "xai", label: "Grok", methods: [{ id: "api-key", label: "API key" }] },
  ],
};
const redirectStep = (attempt = 1): WizardStep => ({
  id: `redirect-${attempt}`,
  type: "text",
  message: "Paste the redirect URL or wait for sign-in to finish.",
  externalUrl: `https://auth.openai.com/oauth/authorize?state=${attempt}`,
});

function inventory(accounts: UserModelAccount[] = []): UsersListModelAccountsResult {
  return {
    profileId: "profile-1",
    accounts,
    links: accounts
      .filter((account) => account.selected)
      .map(({ provider, authProfileId }) => ({ provider, authProfileId, updatedAt: 1 })),
  };
}

type AccountReply = UsersAuthConnectStatusResult | UsersListAuthLinksResult;
async function mount(
  handle: (method: string, params?: unknown) => Promise<AccountReply> = async () => {
    throw new Error("Unexpected account mutation");
  },
  {
    expiresInMs = 60_000,
    scopes = ["operator.write"],
    accounts: initialAccounts = [],
    gatewayUrl,
    step,
  }: {
    expiresInMs?: number;
    scopes?: string[];
    accounts?: UserModelAccount[];
    gatewayUrl?: string;
    step?: WizardStep;
  } = {},
) {
  let starts = 0;
  let listed = inventory(initialAccounts);
  const presented = new Set<string>();
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    switch (method) {
      case "users.authConnect.catalog":
        return catalog;
      case "users.listModelAccounts":
        return listed;
      case "users.authConnect.start":
        return { connectId: `connect-${++starts}`, expiresAtMs: Date.now() + expiresInMs };
      case "users.authConnect.status":
        if (!presented.has(`connect-${starts}`)) {
          presented.add(`connect-${starts}`);
          return { status: "pending", step: step ?? redirectStep(starts) };
        }
    }
    return handle(method, params);
  });
  const client = createTestGatewayClient(request);
  if (gatewayUrl) {
    vi.spyOn(client, "gatewayUrl", "get").mockReturnValue(gatewayUrl);
  }
  const { gateway, publish, publishEvent } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: { type: "hello-ok", protocol: 3, auth: { role: "operator", scopes } },
      selfUser: { id: "profile-1", name: "Ada" },
    }),
  );
  const provider = createSolidApplicationContextProvider({
    gateway,
  } as unknown as ApplicationContext);
  let profileId = "profile-1";
  const target: ModelAccountsTargetSource = {
    read: () => ({ gateway: gateway.snapshot, identityId: "profile-1", profileId }),
    subscribe: (listener) => gateway.subscribe(listener),
  };
  const view = mountSolid(() => <ModelAccounts target={target} />, { wrapper: provider.wrapper });
  const accounts = view.container;
  const button = (selector: string) => accounts.querySelector<HTMLButtonElement>(selector)!;
  await waitForSolid(() => expect(button(auth("add-account")).disabled).toBe(false));
  return {
    accounts,
    showAccounts(next: UserModelAccount[]) {
      listed = inventory(next);
    },
    query: accounts.querySelector.bind(accounts),
    queryAll: (selector: string) => accounts.querySelectorAll(selector),
    button,
    input: (selector: string, value: string) => input(accounts, selector, value),
    text: () => accounts.textContent,
    error: () => accounts.querySelector(ui.alert)?.textContent,
    calls: (method: string) => request.mock.calls.filter(([called]) => called === method),
    expectCall: (method: string, params: Record<string, unknown>) =>
      expect(request).toHaveBeenCalledWith(method, { profileId: "profile-1", ...params }),
    unmount: view.unmount,
    setProfileId(value: string) {
      profileId = value;
      publish(gateway.snapshot);
    },
    request,
    async start(providerId = "openai") {
      button(auth("add-account")).click();
      await waitForSolid(() =>
        expect(button(auth("provider .picker-select__trigger")).disabled).toBe(false),
      );
      await choosePickerValue(accounts.querySelector<HTMLElement>(auth("provider"))!, providerId);
      flush();
      button(auth("connect-start")).click();
      await waitForSolid(() => expect(accounts.querySelector(ui.flow)).not.toBeNull());
      await advance(0);
    },
    emit(next: Partial<ApplicationGatewaySnapshot>, replaceClient = false) {
      publish({
        ...gateway.snapshot,
        ...next,
        ...(replaceClient ? { client: createTestGatewayClient(request) } : {}),
      });
    },
    emitEvent: publishEvent,
  };
}

async function input(accounts: HTMLElement, selector: string, value: string) {
  const element = accounts.querySelector<HTMLInputElement>(selector)!;
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  return element;
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([12, 100])("does not rescan %s unchanged accounts on status publications", async (size) => {
  const accounts = Array.from({ length: size }, (_, index) => ({
    ...personal,
    provider: `provider-${index}`,
    authProfileId: `provider-${index}:personal`,
  }));
  const h = await mount(undefined, { accounts });
  const find = vi.spyOn(Array.prototype, "find");
  const some = vi.spyOn(Array.prototype, "some");
  for (let index = 0; index < 5; index += 1) {
    h.emit({});
    flush();
  }
  const scanned = [...find.mock.contexts, ...some.mock.contexts].filter(
    (rows) => Array.isArray(rows) && rows.length === size,
  );
  find.mockRestore();
  some.mockRestore();
  expect(scanned).toHaveLength(0);
  expect(h.calls("users.listModelAccounts")).toHaveLength(1);
  h.showAccounts(accounts.with(0, { ...accounts[0]!, label: "Renamed" }));
  h.button(auth("accounts-refresh")).click();
  await waitForSolid(() =>
    expect(h.button(auth("link-unlink")).getAttribute("aria-label")).toContain("Renamed"),
  );
});

it("refreshes account defaults and appends later pages without losing earlier choices", async () => {
  const updated = { ...work, selected: true };
  const first = { ...personal, selected: false };
  const later = { ...first, authProfileId: "openai:later" };
  const h = await mount(undefined, { accounts: [personal] });
  const refreshed = inventory([first, updated]);
  h.request.mockResolvedValueOnce({ ...refreshed, nextCursor: "page-2" });
  const currentAccount = () => h.query(auth("link-unlink"))?.getAttribute("aria-label");
  expect(h.text()).not.toContain(first.authProfileId);
  h.emitEvent({ type: "event", event: "chat.metadata.changed", payload: { authChanged: false } });
  flush();
  h.emitEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
  await waitForSolid(() => expect(currentAccount()).toContain(updated.label));
  h.request.mockResolvedValueOnce({ ...inventory([later]), links: refreshed.links });
  h.button(auth("accounts-more")).click();
  await waitForSolid(() => expect(h.queryAll(auth("account-select"))).toHaveLength(2));
  expect(h.text()).toContain(first.authProfileId);
  expect(h.text()).toContain(later.authProfileId);
  expect(h.query(auth("accounts-more"))).toBeNull();
  h.expectCall("users.listModelAccounts", { cursor: "page-2" });
  h.showAccounts([first, { ...later, label: "Later workspace" }]);
  h.button(auth("accounts-refresh")).click();
  await waitForSolid(() => expect(h.text()).toContain("Later workspace"));
  expect(h.text()).not.toContain(first.authProfileId);
  expect(h.text()).not.toContain(later.authProfileId);
  h.unmount();
  h.emitEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
  expect(h.request).toHaveBeenCalledTimes(4);
});

it.each(["select", "link"] as const)(
  "sets and clears an account default through %s",
  async (action) => {
    const saved = action === "select" ? [personal, work] : [work];
    const unlinkReply = createDeferred<UsersListAuthLinksResult>();
    const method = `users.${action === "select" ? "selectModelAccount" : "linkAuthProfile"}`;
    const h = await mount(
      async (called) => {
        expect([method, "users.unlinkAuthProfile"]).toContain(called);
        const unlink = called === "users.unlinkAuthProfile";
        const accounts = saved.map((entry) => ({ ...entry, selected: !unlink && entry === work }));
        h.showAccounts(accounts);
        return unlink ? unlinkReply.promise : { links: inventory(accounts).links };
      },
      {
        accounts: action === "select" ? saved : [],
        scopes: action === "link" ? ["operator.write", "operator.admin"] : ["operator.write"],
      },
    );
    if (action === "link") {
      expect(h.text()).toContain(copy("empty"));
      await h.input(auth("link-input"), work.authProfileId);
      h.button(auth("link-submit")).click();
    } else {
      expect(h.query(auth("link-input"))).toBeNull();
      expect(h.text()).toContain(work.label);
      expect(h.text()).not.toContain(work.authProfileId);
      h.button('[data-auth-profile-id="openai:work"]').click();
    }
    await waitForSolid(() => {
      expect(h.button(auth("link-unlink")).disabled).toBe(false);
      expect(h.button(auth("link-unlink")).getAttribute("aria-label")).toContain(work.label);
    });
    if (action === "link") {
      expect(h.query<HTMLInputElement>(auth("link-input"))?.value).toBe("");
    } else {
      expect(h.query('[data-auth-profile-id="openai:personal"]')).not.toBeNull();
    }
    h.expectCall(method, { authProfileId: work.authProfileId });
    expect(h.text()).toContain(copy("notices.selected"));
    h.button(auth("link-unlink")).click();
    await waitForSolid(() => expect(h.queryAll(auth("account-select"))).toHaveLength(saved.length));
    expect(h.query(auth("link-unlink"))).toBeNull();
    expect(h.query(ui.host)?.getAttribute("aria-busy")).toBe("true");
    unlinkReply.resolve({ links: [] });
    await waitForSolid(() => expect(h.text()).toContain(copy("notices.cleared")));
    h.expectCall("users.unlinkAuthProfile", { provider: "openai" });
    expect(h.request.mock.calls.some(([called]) => called.startsWith("users.authConnect."))).toBe(
      false,
    );
  },
);

it.each(["rejection", "connection replacement"])(
  "restores a pending selection after %s",
  async (outcome) => {
    const pending = createDeferred<UsersListAuthLinksResult>();
    const h = await mount(async () => pending.promise, {
      accounts: [personal, work],
    });
    h.button('[data-auth-profile-id="openai:work"]').click();
    await waitForSolid(() => {
      expect(h.query(ui.host)?.getAttribute("aria-busy")).toBe("true");
      expect(h.button(auth("link-unlink")).getAttribute("aria-label")).toContain(work.label);
    });
    if (outcome === "rejection") {
      pending.reject(new Error("Default selection rejected"));
    } else {
      h.emit({ phase: "connected" }, true);
    }
    await waitForSolid(() => {
      expect(h.query(ui.host)?.getAttribute("aria-busy")).toBe("false");
      expect(h.button(auth("link-unlink")).getAttribute("aria-label")).toContain(personal.label);
      expect(h.button('[data-auth-profile-id="openai:work"]').disabled).toBe(false);
    });
    if (outcome === "rejection") {
      expect(h.error()).toContain("Default selection rejected");
    } else {
      pending.resolve({ links: inventory([{ ...work, selected: true }]).links });
      await advance(0);
      expect(h.button(auth("link-unlink")).getAttribute("aria-label")).toContain(personal.label);
    }
  },
);

it.each(["connection", "profile"] as const)(
  "discards an inventory reply from the previous %s",
  async (scope) => {
    const h = await mount();
    const old = createDeferred<UsersListModelAccountsResult>();
    h.request.mockImplementationOnce(async () => old.promise);
    h.button(auth("accounts-refresh")).click();
    if (scope === "connection") {
      h.emit({ phase: "reconnecting" });
      h.emit({ phase: "connected" });
    } else {
      h.setProfileId("profile-2");
    }
    expect(h.request).toHaveBeenLastCalledWith("users.listModelAccounts", {
      profileId: scope === "connection" ? "profile-1" : "profile-2",
    });
    await waitForSolid(() => expect(h.button(auth("add-account")).disabled).toBe(false));
    old.resolve(inventory([personal]));
    await advance(0);
    expect(h.text()).not.toContain(personal.label);
    await waitForSolid(() => expect(h.button(auth("add-account")).disabled).toBe(false));
  },
);

it("retains the account draft through a failed inventory refresh and recovers on retry", async () => {
  const h = await mount(undefined, {
    accounts: [personal],
    scopes: ["operator.write", "operator.admin"],
  });
  const draft = await h.input(auth("link-input"), "openai:work");
  const pending = createDeferred<UsersListModelAccountsResult>();
  h.request.mockImplementationOnce(async () => pending.promise);
  h.button(auth("accounts-refresh")).click();
  await waitForSolid(() => expect(draft.disabled).toBe(true));
  expect(h.text()).toContain(personal.label);
  pending.reject(new Error("Inventory unavailable"));
  await waitForSolid(() => expect(h.error()).toContain("Inventory unavailable"));
  expect(h.query(auth("link-input"))).toBe(draft);
  expect(draft.value).toBe("openai:work");
  h.button(auth("accounts-refresh")).click();
  await waitForSolid(() => expect(draft.disabled).toBe(false));
  expect(h.query(ui.alert)).toBeNull();
  expect(draft.value).toBe("openai:work");
});

it.each(["failure", "connection replacement"])("retires a held catalog on %s", async (outcome) => {
  const held = createDeferred<UsersAuthConnectCatalogResult>();
  const h = await mount();
  h.request.mockImplementationOnce(async () => held.promise);
  h.button(auth("add-account")).click();
  await waitForSolid(() =>
    expect(h.button(auth("provider .picker-select__trigger")).disabled).toBe(true),
  );
  expect(h.text()).not.toContain(copy("noMethods"));
  if (outcome === "connection replacement") {
    h.emit({ phase: "connected" }, true);
    await waitForSolid(() => expect(h.button(auth("add-account")).disabled).toBe(false));
    held.resolve(catalog);
    await advance(0);
    expect(h.query(".model-accounts-choice")).toBeNull();
    return;
  }
  held.reject(new Error("Catalog unavailable"));
  await waitForSolid(() => expect(h.error()).toContain("Catalog unavailable"));
  h.button(auth("connect-cancel")).click();
  flush();
  h.button(auth("add-account")).click();
  await waitForSolid(() =>
    expect(h.button(auth("provider .picker-select__trigger")).disabled).toBe(false),
  );
  expect(h.query(ui.alert)).toBeNull();
});

it("polls one authorization at a time and uses its recorded outcome", async () => {
  const exchanging = createDeferred<UsersAuthConnectStatusResult>();
  let polls = 0;
  const h = await mount(async (method, params) => {
    expect(method).toBe("users.authConnect.status");
    expect(params).toEqual({ profileId: "profile-1", connectId: "connect-1" });
    polls += 1;
    if (polls === 1) {
      return exchanging.promise;
    }
    return connected;
  });
  await h.start();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(polls).toBe(1);
  exchanging.resolve({
    status: "pending",
    step: { id: "saving", type: "progress", executor: "gateway", message: "Saving account…" },
  });
  await waitForSolid(() => expect(h.text()).toContain("Saving account…"));
  expect(h.button(auth("connect-cancel")).disabled).toBe(false);
  await advance(2_000);
  expect(h.query(ui.notice)?.textContent).toContain("Account added.");
  expect(h.query(ui.flow)).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toBe(2);
});

it.each(["failed", "deadline"] as const)(
  "stops polling on %s without inventing expiry",
  async (outcome) => {
    const deadline = outcome === "deadline";
    const h = await mount(
      async () => (deadline ? { status: "pending" } : { status: "failed", reason: "identity" }),
      { expiresInMs: deadline ? 2_500 : 60_000 },
    );
    await h.start();
    await advance(deadline ? 5_000 : 2_000);
    expect(h.text()).toContain(copy(deadline ? "statusTimedOut" : "connectErrors.identity"));
    expect(h.query(ui.flow) === null).toBe(!deadline);
    expect(h.button(deadline ? auth("connect-cancel") : auth("add-account")).disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls("users.authConnect.status")).toHaveLength(deadline ? 3 : 2);
  },
);

it("waits for cancellation and ignores a late completion from the cancelled attempt", async () => {
  const completion = createDeferred<UsersAuthConnectStatusResult>();
  const cancellation = createDeferred<UsersAuthConnectStatusResult>();
  const h = await mount(async (method) => {
    expect(["users.authConnect.answer", "users.authConnect.cancel"]).toContain(method);
    return method === "users.authConnect.answer" ? completion.promise : cancellation.promise;
  });
  await h.start();
  await h.input(ui.answer, "http://localhost:1455/auth/callback?code=code&state=1");
  h.button(ui.submit).click();
  await waitForSolid(() =>
    expect(h.request).toHaveBeenCalledWith("users.authConnect.answer", expect.anything()),
  );
  h.button(auth("connect-cancel")).click();
  flush();
  h.expectCall("users.authConnect.cancel", { connectId: "connect-1" });
  expect(h.query(ui.flow)).not.toBeNull();
  cancellation.resolve({ status: "cancelled" });
  await waitForSolid(() => expect(h.query(ui.flow)).toBeNull());
  completion.resolve(connected);
  await advance(0);
  expect(h.text()).toContain(copy("notices.cancelled"));
  expect(h.button(auth("add-account")).disabled).toBe(false);
});

it("retains drafts through a blip, then retires the old client and its held poll", async () => {
  const oldPoll = createDeferred<UsersAuthConnectStatusResult>();
  const h = await mount(async () => oldPoll.promise, {
    accounts: [personal],
    scopes: ["operator.write", "operator.admin"],
  });
  await h.input(auth("link-input"), "openai:draft");
  await h.start();
  await h.input(ui.answer, "https://example.test/callback");
  await vi.advanceTimersByTimeAsync(2_000);
  h.emit({ phase: "reconnecting" });
  flush();
  expect(h.text()).toContain(personal.label);
  expect(h.query<HTMLInputElement>(auth("link-input"))?.value).toBe("openai:draft");
  expect(h.query<HTMLInputElement>(ui.answer)?.value).toBe("https://example.test/callback");
  expect(h.button(ui.submit).disabled).toBe(true);
  const requestsBeforeHello = h.request.mock.calls.length;
  h.emit({ phase: "connected", selfUser: undefined });
  await advance(2_000);
  expect(h.query<HTMLInputElement>(ui.answer)?.value).toBe("https://example.test/callback");
  expect(h.button(ui.submit).disabled).toBe(true);
  expect(h.request).toHaveBeenCalledTimes(requestsBeforeHello);
  h.emit({ selfUser: { id: "profile-1", name: "Ada" } });
  await waitForSolid(() => expect(h.button(ui.submit).disabled).toBe(false));
  expect(h.query<HTMLInputElement>(ui.answer)?.value).toBe("https://example.test/callback");
  h.emit({ phase: "connected" }, true);
  flush();
  expect(h.query(ui.flow)).toBeNull();
  expect(h.query<HTMLInputElement>(auth("link-input"))?.value).toBe("");
  await waitForSolid(() => expect(h.button(auth("add-account")).disabled).toBe(false));
  await h.start();
  oldPoll.resolve(connected);
  await advance(0);
  expect(h.query<HTMLAnchorElement>(".wizard-step__external-link")?.href).toContain("state=2");
  expect(h.query(ui.flow)).not.toBeNull();
});

it("keeps repeated failed status checks retryable and retains the answer while checking", async () => {
  let polls = 0;
  const completion = createDeferred<UsersAuthConnectStatusResult>();
  const h = await mount(async () => {
    if (++polls < 3) {
      throw new Error("Gateway disconnected");
    }
    return completion.promise.then((result) => {
      h.showAccounts([personal]);
      return result;
    });
  });
  await h.start();
  await advance(2_000);
  expect(h.error()).toContain("Gateway disconnected");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toBe(1);
  const answer = await h.input(ui.answer, "https://example.test/callback");
  h.button(auth("connect-check")).click();
  await waitForSolid(() => {
    expect(h.error()).toContain("Gateway disconnected");
    expect(h.button(auth("connect-check")).disabled).toBe(false);
  });
  expect(answer.value).toBe("https://example.test/callback");
  h.button(auth("connect-check")).click();
  await waitForSolid(() => expect(h.button(auth("connect-check")).disabled).toBe(true));
  expect(h.query(ui.answer)).toBe(answer);
  expect(answer.value).toBe("https://example.test/callback");
  completion.resolve(connected);
  await waitForSolid(() => expect(h.text()).toContain(personal.label));
  expect(h.query(ui.alert)).toBeNull();
});

it("adds a catalog-provided account through its masked auth step without provider-specific controls", async () => {
  const step = {
    id: "grok-key",
    type: "text" as const,
    title: "Grok API key",
    sensitive: true,
  };
  const account: UserModelAccount = {
    ...personal,
    authProfileId: "xai:personal",
    provider: "xai",
    label: "Ada · Grok",
    authType: "api_key",
  };
  const saving = createDeferred();
  const validationError = "That answer is not valid. Check the sign-in instructions and try again.";
  const answers: unknown[] = [];
  const pending = { status: "pending", step } as const;
  const replies: UsersAuthConnectStatusResult[] = [pending, { ...pending, error: validationError }];
  const h = await mount(
    async (method, params) => {
      if (method === "users.authConnect.status") {
        return pending;
      }
      expect(method).toBe("users.authConnect.answer");
      answers.push(params);
      const reply = replies.shift();
      if (reply) {
        return reply;
      }
      await saving.promise;
      h.showAccounts([account]);
      return {
        status: "connected",
        authProfileId: account.authProfileId,
        links: [{ provider: account.provider, authProfileId: account.authProfileId, updatedAt: 1 }],
      };
    },
    {
      step: { id: "notice", type: "note", message: "Use your own API key." },
      gatewayUrl:
        "wss://synthetic-user:synthetic-password@test.invalid/control?token=synthetic-query#synthetic-fragment",
    },
  );
  expect(h.text()).toContain("wss://test.invalid/control");
  expect(h.accounts.innerHTML).not.toContain("synthetic-");
  await h.start("xai");
  const noteButton = h.button(".wizard-step__actions button.primary");
  noteButton.click();
  await waitForSolid(() => expect(h.query(ui.password)).not.toBeNull());
  noteButton.click();
  expect(h.calls("users.authConnect.answer")).toHaveLength(1);
  h.expectCall("users.authConnect.start", { provider: "xai", method: "api-key" });
  const credential = await h.input(ui.password, "invalid");
  h.button(ui.submit).click();
  await waitForSolid(() => expect(h.error()).toContain(validationError));
  await waitForSolid(() => expect(credential.disabled).toBe(false));
  await h.input(ui.password, "synthetic-grok-key");
  await advance(2_000);
  expect(credential.value).toBe("synthetic-grok-key");
  expect(h.error()).toContain(validationError);
  h.button(ui.submit).click();
  await waitForSolid(() => expect(credential).toMatchObject({ disabled: true, value: "" }));
  saving.resolve();
  await waitForSolid(() => expect(h.query(ui.flow)).toBeNull());
  expect(h.query(ui.alert)).toBeNull();
  expect(h.text()).toContain(account.label);
  const target = { profileId: "profile-1", connectId: "connect-1" };
  expect(answers).toEqual([
    { ...target, stepId: "notice" },
    { ...target, stepId: step.id, value: "invalid" },
    { ...target, stepId: step.id, value: "synthetic-grok-key" },
  ]);
});
