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
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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

const selectors = {
  add: ".profile-auth-add-account",
  refresh: ".profile-auth-accounts-refresh",
  more: ".profile-auth-accounts-more",
  choices: ".profile-auth-account-select",
  draft: ".profile-auth-link-input",
  link: ".profile-auth-link-submit",
  unlink: ".profile-auth-link-unlink",
  provider: ".profile-auth-provider",
  providerTrigger: ".profile-auth-provider .picker-select__trigger",
  start: ".profile-auth-connect-start",
  cancel: ".profile-auth-connect-cancel",
  check: ".profile-auth-connect-check",
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
const work: UserModelAccount = {
  ...personal,
  authProfileId: "openai:work",
  label: "Ada · Work workspace",
  selected: false,
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

function inventory(accounts: UserModelAccount[] = []): UsersListModelAccountsResult {
  return {
    profileId: "profile-1",
    accounts,
    links: accounts
      .filter((account) => account.selected)
      .map(({ provider, authProfileId }) => ({ provider, authProfileId, updatedAt: 1 })),
  };
}

async function mountAccounts(
  handle: (
    method: string,
    params?: unknown,
  ) => Promise<UsersAuthConnectStatusResult | UsersListAuthLinksResult> = async () => {
    throw new Error("Unexpected account mutation");
  },
  {
    expiresInMs = 60_000,
    scopes = ["operator.write"],
    accounts: initialAccounts = [],
    inventoryPages,
    gatewayUrl,
    step,
  }: {
    expiresInMs?: number;
    scopes?: string[];
    accounts?: UserModelAccount[];
    inventoryPages?: UsersListModelAccountsResult[];
    gatewayUrl?: string;
    step?: WizardStep;
  } = {},
) {
  let starts = 0;
  let listed = inventory(initialAccounts);
  const pages = [...(inventoryPages ?? [])];
  const presented = new Set<string>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.authConnect.catalog") {
      return catalog;
    }
    if (method === "users.listModelAccounts") {
      return pages.shift() ?? listed;
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
      hello: { auth: { role: "operator", scopes } },
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
  const view = mountSolid(() => <ModelAccounts target={target} />, {
    wrapper: provider.wrapper,
  });
  const accounts = view.container;
  const button = (selector: string) => accounts.querySelector<HTMLButtonElement>(selector)!;
  await waitForSolid(() => expect(button(selectors.add).disabled).toBe(false));
  return {
    accounts,
    showAccounts(next: UserModelAccount[]) {
      listed = inventory(next);
    },
    query: <T extends Element = HTMLElement>(selector: string) =>
      accounts.querySelector<T>(selector),
    queryAll: (selector: string) => accounts.querySelectorAll(selector),
    button,
    input: (selector: string, value: string) => input(accounts, selector, value),
    get text() {
      return accounts.textContent;
    },
    get error() {
      return accounts.querySelector(selectors.alert)?.textContent;
    },
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
      button(selectors.add).click();
      await waitForSolid(() => expect(button(selectors.providerTrigger).disabled).toBe(false));
      await choosePickerValue(accounts.querySelector<HTMLElement>(selectors.provider)!, providerId);
      flush();
      button(selectors.start).click();
      await waitForSolid(() => expect(accounts.querySelector(selectors.flow)).not.toBeNull());
      await advance(0);
    },
    emit(next: Partial<ApplicationGatewaySnapshot>, replaceClient = false) {
      publish({
        ...gateway.snapshot,
        ...next,
        ...(replaceClient
          ? { client: createTestGatewayClient(request as GatewayBrowserClient["request"]) }
          : {}),
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
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes accounts and their saved default when another client changes authentication", async () => {
  const updated = { ...work, selected: true };
  const h = await mountAccounts(undefined, {
    inventoryPages: [
      { profileId: "profile-1", accounts: [personal], links: connected.links },
      {
        profileId: "profile-1",
        accounts: [{ ...personal, selected: false }, updated],
        links: [{ provider: updated.provider, authProfileId: updated.authProfileId, updatedAt: 2 }],
      },
    ],
  });
  const currentAccount = () => h.query(selectors.unlink)?.getAttribute("aria-label");
  expect(currentAccount()).toContain(personal.label);
  h.emitEvent({
    type: "event",
    event: "chat.metadata.changed",
    payload: { authChanged: false },
  });
  flush();
  expect(h.request).toHaveBeenCalledTimes(1);

  h.emitEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
  await waitForSolid(() => expect(currentAccount()).toContain(updated.label));
  expect(h.queryAll(selectors.choices)).toHaveLength(1);

  h.unmount();
  h.emitEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
  expect(h.request).toHaveBeenCalledTimes(2);
});

it.each(["select", "link"] as const)(
  "sets and clears an account default through %s",
  async (action) => {
    const saved = action === "select" ? [personal, work] : [work];
    const h = await mountAccounts(
      async (method, params) => {
        const unlink = method === "users.unlinkAuthProfile";
        expect(method).toBe(
          unlink
            ? "users.unlinkAuthProfile"
            : action === "select"
              ? "users.selectModelAccount"
              : "users.linkAuthProfile",
        );
        expect(params).toEqual({
          profileId: "profile-1",
          ...(unlink ? { provider: "openai" } : { authProfileId: work.authProfileId }),
        });
        const accounts = saved.map((account) => ({
          ...account,
          selected: !unlink && account === work,
        }));
        h.showAccounts(accounts);
        return { links: inventory(accounts).links };
      },
      {
        accounts: action === "select" ? saved : [],
        scopes: action === "link" ? ["operator.write", "operator.admin"] : ["operator.write"],
      },
    );
    if (action === "link") {
      expect(h.text).toContain(t("profilePage.modelAccounts.empty"));
      await h.input(selectors.draft, work.authProfileId);
      h.button(selectors.link).click();
    } else {
      expect(h.query(selectors.draft)).toBeNull();
      expect(h.text).toContain(work.label);
      expect(h.text).not.toContain(work.authProfileId);
      h.button('[data-auth-profile-id="openai:work"]').click();
    }
    await waitForSolid(() => {
      expect(h.button(selectors.unlink).disabled).toBe(false);
      expect(h.button(selectors.unlink).getAttribute("aria-label")).toContain(work.label);
    });
    if (action === "link") {
      expect(h.query<HTMLInputElement>(selectors.draft)?.value).toBe("");
    } else {
      expect(h.query('[data-auth-profile-id="openai:personal"]')).not.toBeNull();
    }
    expect(h.text).toContain(t("profilePage.modelAccounts.notices.selected"));
    h.button(selectors.unlink).click();
    await waitForSolid(() => expect(h.queryAll(selectors.choices)).toHaveLength(saved.length));
    expect(h.text).toContain(t("profilePage.modelAccounts.notices.cleared"));
    expect(h.query(selectors.unlink)).toBeNull();
    expect(h.request.mock.calls.some(([method]) => method.startsWith("users.authConnect."))).toBe(
      false,
    );
  },
);

it.each(["rejection", "connection replacement"])(
  "restores a pending selection after %s",
  async (outcome) => {
    const pending = createDeferred<UsersListAuthLinksResult>();
    const h = await mountAccounts(async () => pending.promise, {
      accounts: [personal, work],
    });
    h.button('[data-auth-profile-id="openai:work"]').click();
    await waitForSolid(() => {
      expect(h.query(selectors.host)?.getAttribute("aria-busy")).toBe("true");
      expect(h.button(selectors.unlink).getAttribute("aria-label")).toContain(work.label);
    });
    if (outcome === "rejection") {
      pending.reject(new Error("Default selection rejected"));
    } else {
      h.emit({ phase: "connected" }, true);
    }
    await waitForSolid(() => {
      expect(h.query(selectors.host)?.getAttribute("aria-busy")).toBe("false");
      expect(h.button(selectors.unlink).getAttribute("aria-label")).toContain(personal.label);
      expect(h.button('[data-auth-profile-id="openai:work"]').disabled).toBe(false);
    });
    if (outcome === "rejection") {
      expect(h.error).toContain("Default selection rejected");
    } else {
      pending.resolve({
        links: [{ provider: "openai", authProfileId: work.authProfileId, updatedAt: 2 }],
      });
      await advance(0);
      expect(h.button(selectors.unlink).getAttribute("aria-label")).toContain(personal.label);
    }
  },
);

it("loads retained accounts one page at a time without dropping earlier choices", async () => {
  const first = { ...personal, selected: false };
  const second = { ...first, authProfileId: "openai:work" };
  const h = await mountAccounts(undefined, {
    inventoryPages: [
      { profileId: "profile-1", accounts: [first], links: [], nextCursor: "page-2" },
      { profileId: "profile-1", accounts: [second], links: [] },
    ],
  });
  expect(h.text).not.toContain(first.authProfileId);
  h.button(selectors.more).click();
  await waitForSolid(() => expect(h.queryAll(selectors.choices)).toHaveLength(2));
  expect(h.text).toContain(first.authProfileId);
  expect(h.text).toContain(second.authProfileId);
  expect(h.query(selectors.more)).toBeNull();
  h.expectCall("users.listModelAccounts", { cursor: "page-2" });
});

it.each(["connection", "profile"] as const)(
  "discards an inventory reply from the previous %s",
  async (scope) => {
    const h = await mountAccounts();
    const old = createDeferred<UsersListModelAccountsResult>();
    h.request.mockImplementationOnce(async () => old.promise);
    h.button(selectors.refresh).click();
    if (scope === "connection") {
      h.emit({ phase: "reconnecting" });
      h.emit({ phase: "connected" });
    } else {
      h.setProfileId("profile-2");
    }
    expect(h.request).toHaveBeenLastCalledWith("users.listModelAccounts", {
      profileId: scope === "connection" ? "profile-1" : "profile-2",
    });
    await waitForSolid(() => expect(h.button(selectors.add).disabled).toBe(false));
    old.resolve({
      profileId: "profile-1",
      accounts: [personal],
      links: connected.links,
    });
    await advance(0);
    expect(h.text).not.toContain(personal.label);
    await waitForSolid(() => expect(h.button(selectors.add).disabled).toBe(false));
  },
);

it("retains the account draft through a failed inventory refresh and recovers on retry", async () => {
  const h = await mountAccounts(undefined, {
    accounts: [personal],
    scopes: ["operator.write", "operator.admin"],
  });
  const draft = await h.input(selectors.draft, "openai:work");
  const pending = createDeferred<UsersListModelAccountsResult>();
  h.request.mockImplementationOnce(async () => pending.promise);
  h.button(selectors.refresh).click();
  await waitForSolid(() => expect(draft.disabled).toBe(true));
  expect(h.text).toContain(personal.label);
  pending.reject(new Error("Inventory unavailable"));
  await waitForSolid(() => expect(h.error).toContain("Inventory unavailable"));
  expect(h.query(selectors.draft)).toBe(draft);
  expect(draft.value).toBe("openai:work");
  h.request.mockImplementationOnce(async () => ({
    profileId: "profile-1",
    accounts: [personal],
    links: connected.links,
  }));
  h.button(selectors.refresh).click();
  await waitForSolid(() => expect(draft.disabled).toBe(false));
  expect(h.query(selectors.alert)).toBeNull();
  expect(draft.value).toBe("openai:work");
});

it.each(["failure", "connection replacement"])("retires a held catalog on %s", async (outcome) => {
  const held = createDeferred<UsersAuthConnectCatalogResult>();
  const h = await mountAccounts();
  h.request.mockImplementationOnce(async () => held.promise);
  h.button(selectors.add).click();
  await waitForSolid(() => expect(h.button(selectors.providerTrigger).disabled).toBe(true));
  expect(h.text).not.toContain(t("profilePage.modelAccounts.noMethods"));
  if (outcome === "connection replacement") {
    h.emit({ phase: "connected" }, true);
    await waitForSolid(() => expect(h.button(selectors.add).disabled).toBe(false));
    held.resolve(catalog);
    await advance(0);
    expect(h.query(".model-accounts-choice")).toBeNull();
    return;
  }
  held.reject(new Error("Catalog unavailable"));
  await waitForSolid(() => expect(h.error).toContain("Catalog unavailable"));
  h.button(selectors.cancel).click();
  flush();
  h.button(selectors.add).click();
  await waitForSolid(() => expect(h.button(selectors.providerTrigger).disabled).toBe(false));
  expect(h.query(selectors.alert)).toBeNull();
});

it("polls one authorization at a time and uses its recorded outcome", async () => {
  const exchanging = createDeferred<UsersAuthConnectStatusResult>();
  let polls = 0;
  const h = await mountAccounts(async (method, params) => {
    expect(method).toBe("users.authConnect.status");
    expect(params).toEqual({ profileId: "profile-1", connectId: "connect-1" });
    polls += 1;
    if (polls === 1) {
      return exchanging.promise;
    }
    return connected;
  });
  await h.start();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(polls).toBe(1);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(polls).toBe(1);
  exchanging.resolve({
    status: "pending",
    step: { id: "saving", type: "progress", executor: "gateway", message: "Saving account…" },
  });
  await waitForSolid(() => expect(h.text).toContain("Saving account…"));
  expect(h.button(selectors.cancel).disabled).toBe(false);
  await advance(2_000);
  expect(h.query(selectors.notice)?.textContent).toContain("Account added.");
  expect(h.query(selectors.flow)).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toBe(2);
});

it("shows a terminal failed result and stops polling", async () => {
  const h = await mountAccounts(async () => ({ status: "failed", reason: "identity" }));
  await h.start();
  await advance(2_000);
  expect(h.text).toContain(t("profilePage.modelAccounts.connectErrors.identity"));
  expect(h.query(selectors.flow)).toBeNull();
  expect(h.button(selectors.add).disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.calls("users.authConnect.status")).toHaveLength(2);
});

it("waits for cancellation and ignores a late completion from the cancelled attempt", async () => {
  const completion = createDeferred<UsersAuthConnectStatusResult>();
  const cancellation = createDeferred<UsersAuthConnectStatusResult>();
  const h = await mountAccounts(async (method) => {
    if (method === "users.authConnect.answer") {
      return completion.promise;
    }
    if (method === "users.authConnect.cancel") {
      return cancellation.promise;
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await h.start();
  await h.input(selectors.answer, "http://localhost:1455/auth/callback?code=code&state=1");
  h.button(selectors.submit).click();
  await waitForSolid(() =>
    expect(h.request).toHaveBeenCalledWith("users.authConnect.answer", expect.anything()),
  );
  h.button(selectors.cancel).click();
  flush();
  h.expectCall("users.authConnect.cancel", { connectId: "connect-1" });
  expect(h.query(selectors.flow)).not.toBeNull();
  cancellation.resolve({ status: "cancelled" });
  await waitForSolid(() => expect(h.query(selectors.flow)).toBeNull());
  completion.resolve(connected);
  await advance(0);
  expect(h.text).toContain(t("profilePage.modelAccounts.notices.cancelled"));
  expect(h.text).not.toContain(personal.label);
  expect(h.button(selectors.add).disabled).toBe(false);
});

it("retains account data and sign-in input through a blip, but resets them for another client", async () => {
  const h = await mountAccounts(async () => ({ status: "pending", step: redirectStep() }), {
    accounts: [personal],
    scopes: ["operator.write", "operator.admin"],
  });
  await h.input(selectors.draft, "openai:draft");
  await h.start();
  await h.input(selectors.answer, "https://example.test/callback");
  h.emit({ phase: "reconnecting" });
  flush();
  expect(h.text).toContain(personal.label);
  expect(h.query<HTMLInputElement>(selectors.draft)?.value).toBe("openai:draft");
  expect(h.query<HTMLInputElement>(selectors.answer)?.value).toBe("https://example.test/callback");
  expect(h.button(selectors.submit).disabled).toBe(true);
  const requestsBeforeHello = h.request.mock.calls.length;
  h.emit({ phase: "connected", selfUser: undefined });
  await advance(2_000);
  expect(h.query<HTMLInputElement>(selectors.answer)?.value).toBe("https://example.test/callback");
  expect(h.button(selectors.submit).disabled).toBe(true);
  expect(h.request).toHaveBeenCalledTimes(requestsBeforeHello);
  h.emit({ selfUser: { id: "profile-1", name: "Ada" } });
  await waitForSolid(() => expect(h.button(selectors.submit).disabled).toBe(false));
  expect(h.query<HTMLInputElement>(selectors.answer)?.value).toBe("https://example.test/callback");
  h.emit({ phase: "connected" }, true);
  flush();
  expect(h.query(selectors.flow)).toBeNull();
  expect(h.query<HTMLInputElement>(selectors.draft)?.value).toBe("");
  h.unmount();
});

it("does not apply an old poll after replacing the connection and starting a new attempt", async () => {
  const oldPoll = createDeferred<UsersAuthConnectStatusResult>();
  const h = await mountAccounts(async () => oldPoll.promise);
  await h.start();
  await vi.advanceTimersByTimeAsync(2_000);
  h.emit({ phase: "reconnecting" });
  h.emit({ phase: "connected" }, true);
  await waitForSolid(() => expect(h.button(selectors.add).disabled).toBe(false));
  await h.start();
  oldPoll.resolve(connected);
  await advance(0);
  expect(h.query<HTMLAnchorElement>(".wizard-step__external-link")?.href).toContain("state=2");
  expect(h.text).not.toContain(personal.label);
  expect(h.query(selectors.flow)).not.toBeNull();
});

it("keeps repeated failed status checks retryable and retains the answer while checking", async () => {
  let polls = 0;
  const completion = createDeferred<UsersAuthConnectStatusResult>();
  const h = await mountAccounts(async () => {
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
  expect(h.error).toContain("Gateway disconnected");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toBe(1);
  const answer = await h.input(selectors.answer, "https://example.test/callback");
  h.button(selectors.check).click();
  await waitForSolid(() => {
    expect(h.error).toContain("Gateway disconnected");
    expect(h.button(selectors.check).disabled).toBe(false);
  });
  expect(answer.value).toBe("https://example.test/callback");
  h.button(selectors.check).click();
  await waitForSolid(() => expect(h.button(selectors.check).disabled).toBe(true));
  expect(h.query(selectors.answer)).toBe(answer);
  expect(answer.value).toBe("https://example.test/callback");
  completion.resolve(connected);
  await waitForSolid(() => expect(h.text).toContain(personal.label));
  expect(h.query(selectors.alert)).toBeNull();
});

it("stops at the operation deadline without pretending an unknown attempt expired", async () => {
  const h = await mountAccounts(async () => ({ status: "pending" }), { expiresInMs: 2_500 });
  await h.start();
  await advance(5_000);
  expect(h.text).toContain(t("profilePage.modelAccounts.statusTimedOut"));
  expect(h.query(selectors.flow)).not.toBeNull();
  expect(h.button(selectors.cancel).disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.calls("users.authConnect.status")).toHaveLength(3);
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
  const h = await mountAccounts(
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
  expect(h.query(selectors.password)).toBeNull();
  expect(h.text).toContain("wss://test.invalid/control");
  expect(h.accounts.innerHTML).not.toContain("synthetic-");
  await h.start("xai");
  expect(h.text).toContain("Use your own API key.");
  const noteButton = h.button(".wizard-step__actions button.primary");
  noteButton.click();
  await waitForSolid(() => expect(h.query(selectors.password)).not.toBeNull());
  noteButton.click();
  expect(h.calls("users.authConnect.answer")).toHaveLength(1);
  h.expectCall("users.authConnect.start", { provider: "xai", method: "api-key" });
  const credential = await h.input(selectors.password, "invalid");
  h.button(selectors.submit).click();
  await waitForSolid(() => expect(h.error).toContain(validationError));
  await waitForSolid(() => expect(credential.disabled).toBe(false));
  await h.input(selectors.password, "synthetic-grok-key");
  await advance(2_000);
  expect(credential.value).toBe("synthetic-grok-key");
  expect(h.error).toContain(validationError);
  h.button(selectors.submit).click();
  await waitForSolid(() => expect(credential.disabled).toBe(true));
  expect(credential.value).toBe("");
  saving.resolve();
  await waitForSolid(() => expect(h.query(selectors.flow)).toBeNull());
  expect(h.query(selectors.password)).toBeNull();
  expect(h.query(selectors.alert)).toBeNull();
  expect(h.text).toContain(account.label);
});
