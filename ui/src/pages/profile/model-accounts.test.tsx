/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  UserModelAccount,
  UserProfileAuthLink,
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStatusResult,
  UsersListAuthLinksResult,
  UsersListModelAccountsResult,
  WizardStep,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n, t } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ModelAccountsTargetSource } from "./model-accounts-state.ts";
import { ModelAccounts } from "./model-accounts.tsx";
import { createConnectedContext } from "./profile-page.test-support.tsx";

const connectedResult: UsersAuthConnectStatusResult = {
  status: "connected",
  authProfileId: "openai:personal",
  links: [{ provider: "openai", authProfileId: "openai:personal", updatedAt: 1 }],
};

const connectedAccount: UserModelAccount = {
  authProfileId: "openai:personal",
  provider: "openai",
  label: "Ada · Personal workspace",
  authType: "oauth",
  selected: true,
};
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

async function mountAccounts(
  handle: (
    method: string,
    params?: unknown,
  ) => Promise<UsersAuthConnectStatusResult | UsersListAuthLinksResult>,
  {
    expiresInMs = 60_000,
    scopes = ["operator.write"],
    accounts: initialAccounts = [],
    inventoryPages,
    gatewayUrl,
    step,
    connectedAccounts = [connectedAccount],
  }: {
    expiresInMs?: number;
    scopes?: string[];
    accounts?: UserModelAccount[];
    inventoryPages?: UsersListModelAccountsResult[];
    gatewayUrl?: string;
    step?: WizardStep;
    connectedAccounts?: UserModelAccount[];
  } = {},
) {
  let starts = 0;
  let savedAccounts = initialAccounts;
  let links: UserProfileAuthLink[] = savedAccounts
    .filter((account) => account.selected)
    .map((account) => ({
      provider: account.provider,
      authProfileId: account.authProfileId,
      updatedAt: 1,
    }));
  let inventoryPage = 0;
  const fixtures = [
    ...savedAccounts,
    ...(inventoryPages?.flatMap((page) => page.accounts) ?? []),
    ...connectedAccounts,
  ];
  const presented = new Set<string>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.authConnect.catalog") {
      return catalog;
    }
    if (method === "users.listModelAccounts") {
      const page = inventoryPages?.[inventoryPage++];
      if (page) {
        savedAccounts = [
          ...new Map(
            [...savedAccounts, ...page.accounts].map((account) => [account.authProfileId, account]),
          ).values(),
        ];
        links = page.links;
      }
      return page ?? { profileId: "profile-1", accounts: savedAccounts, links };
    }
    if (method === "users.authConnect.start") {
      starts += 1;
      return {
        connectId: `connect-${starts}`,
        expiresAtMs: Date.now() + expiresInMs,
      };
    }
    if (method === "users.authConnect.status" && !presented.has(`connect-${starts}`)) {
      presented.add(`connect-${starts}`);
      return { status: "pending", step: step ?? redirectStep(starts) };
    }
    const result = await handle(method, params);
    if ("links" in result) {
      links = result.links;
      const saved = new Map(savedAccounts.map((account) => [account.authProfileId, account]));
      for (const link of links) {
        const account = fixtures.find(
          (candidate) => candidate.authProfileId === link.authProfileId,
        );
        if (account) {
          saved.set(account.authProfileId, account);
        }
      }
      savedAccounts = [...saved.values()].map((account) =>
        Object.assign({}, account, {
          selected: links.some((link) => link.authProfileId === account.authProfileId),
        }),
      );
    }
    return result;
  });
  const client = createTestGatewayClient(request);
  if (gatewayUrl) {
    vi.spyOn(client, "gatewayUrl", "get").mockReturnValue(gatewayUrl);
  }
  const { context, emitSnapshot } = createConnectedContext(client.request, {
    id: "profile-1",
    name: "Ada",
  });
  context.gateway.snapshot.client = client;
  context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes },
  } as ApplicationGatewaySnapshot["hello"];
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  context.gateway.subscribeEvents = (listener) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  };
  const provider = createSolidApplicationContextProvider(context);
  let profileId = "profile-1";
  const target: ModelAccountsTargetSource = {
    read: () => ({ gateway: context.gateway.snapshot, identityId: "profile-1", profileId }),
    subscribe: (listener) => context.gateway.subscribe(listener),
  };
  const view = mountSolid(() => <ModelAccounts target={target} />, {
    wrapper: provider.wrapper,
  });
  const accounts = view.container;
  await waitForSolid(() =>
    expect(button(accounts, ".profile-auth-add-account").disabled).toBe(false),
  );
  return {
    accounts,
    query: <T extends Element = HTMLElement>(selector: string) =>
      accounts.querySelector<T>(selector),
    click: (selector: string) => button(accounts, selector).click(),
    enter: (selector: string, value: string) => input(accounts, selector, value),
    enabled: (selector: string) =>
      waitForSolid(() => expect(button(accounts, selector).disabled).toBe(false)),
    unmount: view.unmount,
    setProfileId(value: string) {
      profileId = value;
      emitSnapshot({});
    },
    request,
    async start(providerId = "openai") {
      button(accounts, ".profile-auth-add-account").click();
      await waitForSolid(() =>
        expect(button(accounts, ".profile-auth-provider .picker-select__trigger").disabled).toBe(
          false,
        ),
      );
      await openPicker(accounts.querySelector<HTMLElement>(".profile-auth-provider")!);
      await waitForSolid(() =>
        expect(
          accounts.querySelector(
            `.profile-auth-provider [role="option"][data-value="${providerId}"]`,
          ),
        ).not.toBeNull(),
      );
      await choosePickerValue(
        accounts.querySelector<HTMLElement>(".profile-auth-provider")!,
        providerId,
      );
      flush();
      button(accounts, ".profile-auth-connect-start").click();
      await waitForSolid(() =>
        expect(accounts.querySelector(".model-accounts-flow")).not.toBeNull(),
      );
      await tick(0);
    },
    emit(phase: ApplicationGatewaySnapshot["phase"], replaceClient = false) {
      emitSnapshot({
        phase,
        ...(replaceClient ? { client: createTestGatewayClient(request) } : {}),
      });
    },
    emitEvent(event: GatewayEventFrame) {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    emitSnapshot,
  };
}

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}
function inventory(
  accounts: UserModelAccount[],
  links: UserProfileAuthLink[] = [],
  nextCursor?: string,
): UsersListModelAccountsResult {
  return { profileId: "profile-1", accounts, links, ...(nextCursor ? { nextCursor } : {}) };
}
function callCount(request: { mock: { calls: unknown[][] } }, method: string) {
  return request.mock.calls.filter(([called]) => called === method).length;
}
function button(root: ParentNode, selector: string) {
  const element = root.querySelector<HTMLButtonElement>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

async function input(accounts: HTMLElement, selector: string, value: string) {
  const element = accounts.querySelector<HTMLInputElement>(selector)!;
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  return element;
}

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes accounts and their saved default when another client changes authentication", async () => {
  const work = {
    ...connectedAccount,
    authProfileId: "openai:work",
    label: "Ada · Work workspace",
  };
  const harness = await mountAccounts(
    async () => {
      throw new Error("Unexpected account mutation");
    },
    {
      inventoryPages: [
        inventory([connectedAccount], connectedResult.links),
        {
          profileId: "profile-1",
          accounts: [{ ...connectedAccount, selected: false }, work],
          links: [{ provider: work.provider, authProfileId: work.authProfileId, updatedAt: 2 }],
        },
      ],
    },
  );
  const { accounts, query, request } = harness;
  const currentAccount = () => query(".profile-auth-link-unlink")?.getAttribute("aria-label");
  expect(currentAccount()).toContain(connectedAccount.label);
  harness.emitEvent({
    type: "event",
    event: "chat.metadata.changed",
    payload: { authChanged: false },
  });
  flush();
  expect(request).toHaveBeenCalledTimes(1);

  harness.emitEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
  await waitForSolid(() => expect(currentAccount()).toContain(work.label));
  expect(accounts.querySelectorAll(".profile-auth-account-select")).toHaveLength(1);

  harness.unmount();
  harness.emitEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "selects and clears an account without removing it (admin link: %s)",
  async (admin) => {
    const work = {
      ...connectedAccount,
      authProfileId: "openai:work",
      label: "Ada · Work workspace",
      selected: false,
    };
    const selected = admin ? connectedAccount : work;
    const action = admin ? "users.linkAuthProfile" : "users.selectModelAccount";
    const harness = await mountAccounts(
      async (method, params) => {
        if (method === action) {
          expect(params).toEqual({ profileId: "profile-1", authProfileId: selected.authProfileId });
          return {
            links: [
              {
                provider: "openai",
                authProfileId: selected.authProfileId,
                updatedAt: admin ? 1 : 2,
              },
            ],
          };
        }
        expect(method).toBe("users.unlinkAuthProfile");
        expect(params).toEqual({ profileId: "profile-1", provider: "openai" });
        return { links: [] };
      },
      {
        accounts: admin ? [] : [connectedAccount, work],
        scopes: admin ? ["operator.write", "operator.admin"] : ["operator.write"],
      },
    );
    const { accounts, query, click, enter, enabled, request } = harness;
    if (admin) {
      expect(accounts.textContent).toContain(t("profilePage.modelAccounts.empty"));
      const linkInput = await enter(".profile-auth-link-input", connectedAccount.authProfileId);
      click(".profile-auth-link-submit");
      await waitForSolid(() => expect(accounts.textContent).toContain(connectedAccount.label));
      expect(linkInput.value).toBe("");
    } else {
      expect(query(".profile-auth-link-input")).toBeNull();
      expect(accounts.textContent).toContain(connectedAccount.label);
      expect(accounts.textContent).toContain(work.label);
      expect(accounts.textContent).not.toContain(work.authProfileId);
      click(`[data-auth-profile-id="${work.authProfileId}"]`);
      await waitForSolid(() =>
        expect(accounts.textContent).toContain(t("profilePage.modelAccounts.notices.selected")),
      );
      expect(query('[data-auth-profile-id="openai:personal"]')).not.toBeNull();
    }
    expect(request).toHaveBeenCalledWith(action, {
      profileId: "profile-1",
      authProfileId: selected.authProfileId,
    });
    await enabled(".profile-auth-link-unlink");
    click(".profile-auth-link-unlink");
    if (admin) {
      await waitForSolid(() =>
        expect(accounts.textContent).toContain(t("profilePage.modelAccounts.empty")),
      );
    } else {
      await waitForSolid(() =>
        expect(accounts.textContent).toContain(t("profilePage.modelAccounts.notices.cleared")),
      );
      await waitForSolid(() =>
        expect(accounts.querySelectorAll(".profile-auth-account-select")).toHaveLength(2),
      );
      expect(query(".profile-auth-link-unlink")).toBeNull();
      expect(request.mock.calls.some(([method]) => method.startsWith("users.authConnect."))).toBe(
        false,
      );
    }
    expect(request).toHaveBeenCalledWith("users.unlinkAuthProfile", {
      profileId: "profile-1",
      provider: "openai",
    });
  },
);

it("loads retained accounts one page at a time without dropping earlier choices", async () => {
  const first = { ...connectedAccount, selected: false };
  const second = { ...first, authProfileId: "openai:work" };
  const harness = await mountAccounts(
    async () => {
      throw new Error("Unexpected account mutation");
    },
    {
      inventoryPages: [inventory([first], [], "page-2"), inventory([second])],
    },
  );
  const { accounts, query, click, request } = harness;
  expect(accounts.textContent).not.toContain(first.authProfileId);
  click(".profile-auth-accounts-more");
  await waitForSolid(() =>
    expect(accounts.querySelectorAll(".profile-auth-account-select")).toHaveLength(2),
  );
  expect(accounts.textContent).toContain(first.authProfileId);
  expect(accounts.textContent).toContain(second.authProfileId);
  expect(query(".profile-auth-accounts-more")).toBeNull();
  expect(request).toHaveBeenCalledWith("users.listModelAccounts", {
    profileId: "profile-1",
    cursor: "page-2",
  });
});

it.each(["connection", "profile"] as const)(
  "discards an inventory reply from the previous %s",
  async (scope) => {
    const harness = await mountAccounts(async () => {
      throw new Error("Unexpected account mutation");
    });
    const { accounts, click, enabled, request } = harness;
    const old = createDeferred<UsersListModelAccountsResult>();
    request.mockImplementationOnce(async () => old.promise);
    click(".profile-auth-accounts-refresh");
    if (scope === "connection") {
      harness.emit("reconnecting");
      harness.emit("connected");
    } else {
      harness.setProfileId("profile-2");
    }
    expect(request).toHaveBeenLastCalledWith("users.listModelAccounts", {
      profileId: scope === "connection" ? "profile-1" : "profile-2",
    });
    old.resolve({
      profileId: "profile-1",
      accounts: [connectedAccount],
      links: connectedResult.links,
    });
    await tick(0);
    expect(accounts.textContent).not.toContain(connectedAccount.label);
    await enabled(".profile-auth-add-account");
  },
);

it("polls one authorization at a time and uses its recorded outcome", async () => {
  const exchanging = createDeferred<UsersAuthConnectStatusResult>();
  let polls = 0;
  const harness = await mountAccounts(async (method, params) => {
    expect(method).toBe("users.authConnect.status");
    expect(params).toEqual({ profileId: "profile-1", connectId: "connect-1" });
    polls += 1;
    return polls === 1 ? exchanging.promise : connectedResult;
  });
  const { accounts, query, request } = harness;
  await harness.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(polls).toBe(1);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(polls).toBe(1);
  exchanging.resolve({
    status: "pending",
    step: { id: "saving", type: "progress", executor: "gateway", message: "Saving account…" },
  });
  await waitForSolid(() => expect(accounts.textContent).toContain("Saving account…"));
  expect(button(accounts, ".profile-auth-connect-cancel").disabled).toBe(false);
  await tick(2_000);
  expect(accounts.textContent).toContain(connectedAccount.label);
  expect(query(".model-accounts-notice")?.textContent).toContain("Account added.");
  expect(query(".model-accounts-flow")).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toBe(2);
  expect(callCount(request, "users.listModelAccounts")).toBe(2);
});

it("shows a terminal identity failure and stops polling", async () => {
  const harness = await mountAccounts(async () => ({ status: "failed", reason: "identity" }));
  const { accounts, query, request } = harness;
  await harness.start();
  await tick(2_000);
  expect(accounts.textContent).toContain(t("profilePage.modelAccounts.connectErrors.identity"));
  expect(query(".model-accounts-flow")).toBeNull();
  expect(button(accounts, ".profile-auth-add-account").disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(callCount(request, "users.authConnect.status")).toBe(2);
});

it("waits for cancellation and ignores a late completion from the cancelled attempt", async () => {
  const completion = createDeferred<UsersAuthConnectStatusResult>();
  const cancellation = createDeferred<UsersAuthConnectStatusResult>();
  const harness = await mountAccounts(async (method) => {
    if (method === "users.authConnect.answer") {
      return completion.promise;
    }
    if (method === "users.authConnect.cancel") {
      return cancellation.promise;
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const { accounts, query, click, enter, request } = harness;
  await harness.start();
  await enter(".wizard-step__form input", "http://localhost:1455/auth/callback?code=code&state=1");
  click('.wizard-step__form button[type="submit"]');
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.authConnect.answer", expect.anything()),
  );
  click(".profile-auth-connect-cancel");
  flush();
  expect(request).toHaveBeenCalledWith("users.authConnect.cancel", {
    profileId: "profile-1",
    connectId: "connect-1",
  });
  expect(query(".model-accounts-flow")).not.toBeNull();
  cancellation.resolve({ status: "cancelled" });
  await waitForSolid(() => expect(query(".model-accounts-flow")).toBeNull());
  completion.resolve(connectedResult);
  await tick(0);
  expect(accounts.textContent).toContain(t("profilePage.modelAccounts.notices.cancelled"));
  expect(accounts.textContent).not.toContain(connectedAccount.label);
  expect(button(accounts, ".profile-auth-add-account").disabled).toBe(false);
});

it("retains account data and sign-in input through a blip, but resets them for another client", async () => {
  const harness = await mountAccounts(async () => ({ status: "pending", step: redirectStep() }), {
    accounts: [connectedAccount],
    scopes: ["operator.write", "operator.admin"],
  });
  const { accounts, query, enter, enabled, request } = harness;
  await enter(".profile-auth-link-input", "openai:draft");
  await harness.start();
  await enter(".wizard-step__form input", "https://example.test/callback");
  harness.emit("reconnecting");
  flush();
  expect(accounts.textContent).toContain(connectedAccount.label);
  expect(query<HTMLInputElement>(".profile-auth-link-input")?.value).toBe("openai:draft");
  expect(query<HTMLInputElement>(".wizard-step__form input")?.value).toBe(
    "https://example.test/callback",
  );
  expect(button(accounts, '.wizard-step__form button[type="submit"]').disabled).toBe(true);
  const requestsBeforeHello = request.mock.calls.length;
  harness.emitSnapshot({ phase: "connected", selfUser: undefined });
  await tick(2_000);
  expect(query<HTMLInputElement>(".wizard-step__form input")?.value).toBe(
    "https://example.test/callback",
  );
  expect(button(accounts, '.wizard-step__form button[type="submit"]').disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(requestsBeforeHello);
  harness.emitSnapshot({ selfUser: { id: "profile-1", name: "Ada" } });
  await enabled('.wizard-step__form button[type="submit"]');
  expect(query<HTMLInputElement>(".wizard-step__form input")?.value).toBe(
    "https://example.test/callback",
  );
  harness.emit("connected", true);
  flush();
  expect(query(".model-accounts-flow")).toBeNull();
  expect(query<HTMLInputElement>(".profile-auth-link-input")?.value).toBe("");
  harness.unmount();
});

it("does not apply an old poll after replacing the connection and starting a new attempt", async () => {
  const oldPoll = createDeferred<UsersAuthConnectStatusResult>();
  const harness = await mountAccounts(async () => oldPoll.promise);
  const { accounts, query, enabled } = harness;
  await harness.start();
  await vi.advanceTimersByTimeAsync(2_000);
  harness.emit("reconnecting");
  harness.emit("connected", true);
  await enabled(".profile-auth-add-account");
  await harness.start();
  oldPoll.resolve(connectedResult);
  await tick(0);
  expect(query<HTMLAnchorElement>(".wizard-step__external-link")?.href).toContain("state=2");
  expect(accounts.textContent).not.toContain(connectedAccount.label);
  expect(query(".model-accounts-flow")).not.toBeNull();
});

it("keeps a failed status check visible and lets the person retry it", async () => {
  let polls = 0;
  const harness = await mountAccounts(async () => {
    if (++polls === 1) {
      throw new Error("Gateway disconnected");
    }
    return connectedResult;
  });
  const { accounts, query, click } = harness;
  await harness.start();
  await tick(2_000);
  expect(query('[role="alert"]')?.textContent).toContain("Gateway disconnected");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toBe(1);
  click(".profile-auth-connect-check");
  await waitForSolid(() => expect(accounts.textContent).toContain(connectedAccount.label));
  expect(query('[role="alert"]')).toBeNull();
});

it("stops at the operation deadline without pretending an unknown attempt expired", async () => {
  const harness = await mountAccounts(async () => ({ status: "pending" }), { expiresInMs: 2_500 });
  const { accounts, query, request } = harness;
  await harness.start();
  await tick(5_000);
  expect(accounts.textContent).toContain(t("profilePage.modelAccounts.statusTimedOut"));
  expect(query(".model-accounts-flow")).not.toBeNull();
  expect(button(accounts, ".profile-auth-connect-cancel").disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(callCount(request, "users.authConnect.status")).toBe(3);
});

it("adds a catalog-provided account through its masked auth step without provider-specific controls", async () => {
  const step = {
    id: "grok-key",
    type: "text" as const,
    title: "Grok API key",
    message: "Enter your Grok API key",
    sensitive: true,
  };
  const account: UserModelAccount = {
    authProfileId: "xai:personal",
    provider: "xai",
    label: "Ada · Grok",
    authType: "api_key",
    selected: true,
  };
  const saving = createDeferred();
  const validationError = "That answer is not valid. Check the sign-in instructions and try again.";
  const harness = await mountAccounts(
    async (method, params) => {
      if (method === "users.authConnect.status") {
        return { status: "pending", step };
      }
      expect(method).toBe("users.authConnect.answer");
      if ((params as { stepId: string }).stepId === "notice") {
        expect(params).toEqual({
          profileId: "profile-1",
          connectId: "connect-1",
          stepId: "notice",
        });
        return { status: "pending", step };
      }
      if ((params as { value: string }).value === "invalid") {
        return { status: "pending", step, error: validationError };
      }
      expect(params).toEqual({
        profileId: "profile-1",
        connectId: "connect-1",
        stepId: step.id,
        value: "synthetic-grok-key",
      });
      await saving.promise;
      return {
        status: "connected",
        authProfileId: account.authProfileId,
        links: [{ provider: account.provider, authProfileId: account.authProfileId, updatedAt: 1 }],
      };
    },
    {
      step: { id: "notice", type: "note", message: "Use your own API key." },
      connectedAccounts: [account],
      gatewayUrl:
        "wss://synthetic-user:synthetic-password@test.invalid/control?token=synthetic-query#synthetic-fragment",
    },
  );
  const { accounts, query, click, enter, request } = harness;
  expect(query('input[type="password"]')).toBeNull();
  expect(accounts.textContent).toContain("wss://test.invalid/control");
  expect(accounts.innerHTML).not.toContain("synthetic-");
  await harness.start("xai");
  expect(accounts.textContent).toContain("Use your own API key.");
  const noteButton = button(accounts, ".wizard-step__actions button.primary");
  noteButton.click();
  await waitForSolid(() => expect(query('input[type="password"]')).not.toBeNull());
  noteButton.click();
  expect(callCount(request, "users.authConnect.answer")).toBe(1);
  expect(request).toHaveBeenCalledWith("users.authConnect.start", {
    profileId: "profile-1",
    provider: "xai",
    method: "api-key",
  });
  const credential = await enter('input[type="password"]', "invalid");
  click('.wizard-step__form button[type="submit"]');
  await waitForSolid(() => expect(query('[role="alert"]')?.textContent).toContain(validationError));
  await waitForSolid(() => expect(credential.disabled).toBe(false));
  await enter('input[type="password"]', "synthetic-grok-key");
  await tick(2_000);
  expect(credential.value).toBe("synthetic-grok-key");
  expect(query('[role="alert"]')?.textContent).toContain(validationError);
  click('.wizard-step__form button[type="submit"]');
  await waitForSolid(() => expect(credential.disabled).toBe(true));
  expect(credential).toMatchObject({ value: "" });
  saving.resolve();
  await waitForSolid(() => expect(query(".model-accounts-flow")).toBeNull());
  expect(query('input[type="password"]')).toBeNull();
  expect(query('[role="alert"]')).toBeNull();
  expect(accounts.textContent).toContain(account.label);
});
