/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showToast } from "../toast.ts";
import { browserSignOutUrl } from "./browser-sign-out.ts";
// mock-isolation: toasts are observed without mounting the shell.
vi.mock("../toast.ts", () => ({ showToast: vi.fn() }));

const ACCOUNT = "openclaw.openclawId.account";
const EPOCH = "openclaw.openclawId.signedOut";
const token = `header.${btoa(JSON.stringify({ iss: "https://id.example.test/api/auth" }))}.signature`;
const signedIn = {
  sub: "test",
  email: "test@example.test",
  name: "Test",
  exp: Date.now() / 1000 + 3600,
  idToken: token,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Each test gets one document-owned account module and an isolated browser storage owner.
async function browser(initial = true) {
  vi.resetModules();
  const entries = new Map<string, string>(initial ? [[ACCOUNT, JSON.stringify(signedIn)]] : []);
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  const documentWindow = new EventTarget();
  const assign = vi.fn();
  const popup = { location: { href: "" }, close: vi.fn() };
  Object.assign(documentWindow, {
    location: { origin: "http://localhost:18790", href: "http://localhost:18790/", assign },
    history: { replaceState: vi.fn() },
    open: () => popup,
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", documentWindow);
  const account = await import("./account.ts");
  return { account, storage, documentWindow, assign, popup };
}

it("local sign-out immediately clears the account and navigates to safe issuer confirmation", async () => {
  const { account, storage, assign } = await browser();
  const observed = vi.fn();
  account.subscribeOpenClawIdAccount(observed);
  account.signOutOfOpenClawId();
  expect(account.openClawIdAccount()).toBeNull();
  expect(storage.getItem(ACCOUNT)).toBeNull();
  expect(observed).toHaveBeenLastCalledWith(null);
  const target = new URL(assign.mock.calls[0]![0]);
  expect(target.origin + target.pathname).toBe("https://id.example.test/logout");
  expect(target.searchParams.get("return_to")).toBe(
    "http://localhost:18790/?openclaw_id_signed_out=1",
  );
});

it("another tab's sign-out clears the projection and fences an in-flight popup", async () => {
  const { account, storage, documentWindow, popup } = await browser();
  let begin!: (value: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise((resolve) => {
        begin = resolve;
      }),
  );
  const pending = account.signInWithOpenClawId({
    client: { request } as unknown as GatewayBrowserClient,
    basePath: "",
  });
  storage.removeItem(ACCOUNT);
  storage.setItem(EPOCH, "other-tab-signout");
  expect(account.openClawIdAccount()).toBeNull(); // Frozen tab has not received its event yet.
  documentWindow.dispatchEvent(
    new StorageEvent("storage", { key: EPOCH, newValue: "other-tab-signout" }),
  );
  expect(account.openClawIdAccount()).toBeNull();
  begin({ authorizationUrl: "https://id.example.test/api/auth/oauth2/authorize", state: "state" });
  await expect(pending).rejects.toThrow("signed out while sign-in was in progress");
  expect(popup.close).toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  expect(storage.getItem(ACCOUNT)).toBeNull();
});

it("builds logout without secret/query/fragment passthrough and refuses insecure issuers", () => {
  const url = new URL(
    browserSignOutUrl(
      "https://id.example.test/api/auth",
      "http://localhost:18790/?token=secret#private",
    ),
  );
  expect(url.searchParams.get("return_to")).toBe(
    "http://localhost:18790/?openclaw_id_signed_out=1",
  );
  expect(() => browserSignOutUrl("http://id.example.test", "http://localhost/")).toThrow(
    "invalid issuer",
  );
});

it("clears local account even with malformed issuer metadata and no secure-context UUID API", async () => {
  const { account, storage, documentWindow, assign } = await browser();
  vi.stubGlobal("crypto", {});
  storage.setItem(ACCOUNT, JSON.stringify({ ...signedIn, idToken: "malformed" }));
  documentWindow.dispatchEvent(new StorageEvent("storage", { key: ACCOUNT }));
  expect(() => account.signOutOfOpenClawId()).not.toThrow();
  expect(account.openClawIdAccount()).toBeNull();
  expect(storage.getItem(ACCOUNT)).toBeNull();
  expect(storage.getItem(EPOCH)).toBeTruthy();
  expect(assign).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith({
    severity: "warning",
    message: expect.stringContaining("could not finish"),
  });
});

it("rejects retained and delayed Make reachable link-code requests after another tab signs out", async () => {
  const { account, storage } = await browser();
  let release!: (value: { code: string }) => void;
  const request = vi.fn(
    () =>
      new Promise<{ code: string }>((resolve) => {
        release = resolve;
      }),
  );
  const client = { request } as unknown as GatewayBrowserClient;
  const pending = account.requestOpenClawIdLinkCode(client, signedIn);
  expect(request).toHaveBeenCalledTimes(1);
  storage.removeItem(ACCOUNT);
  storage.setItem(EPOCH, "another-tab-logged-out");
  release({ code: "unused-synthetic-enrollment-code" });
  await expect(pending).rejects.toThrow("signed out while linking");
  await expect(account.requestOpenClawIdLinkCode(client, signedIn)).rejects.toThrow(
    "signed out while linking",
  );
  expect(request).toHaveBeenCalledTimes(1);
});
