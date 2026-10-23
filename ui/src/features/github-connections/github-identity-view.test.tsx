import { createRouter, definePage } from "@openclaw/uirouter";
import { getQueriesForElement } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { mountRouterOutlet, settleRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { createGitHubIdentityView } from "../../lib/reactive/domain-github-identity.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  authorizationCode,
  availableStatus,
  createMutationRunner,
  setupRequest,
  sharedTarget,
} from "./github-identity-harness.test-support.ts";
import type { GitHubAuthorizationState } from "./github-identity-shared.ts";
import {
  GitHubConnectionError,
  GitHubConnectionSetup,
  GitHubIdentity,
} from "./github-identity-view.tsx";
import {
  createGitHubIdentityForTest,
  githubIdentityViewFixture,
} from "./github-identity.test-support.ts";

const writeText = vi.fn<(text: string) => Promise<void>>();
const fallback = vi.fn(() => true);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  fallback.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: fallback });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  if (execCommandDescriptor) {
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
});

describe("GitHub identity view", () => {
  it("shows device request and cancellation progress before the server settles", async () => {
    const start = createDeferred<typeof authorizationCode>();
    const cancel = createDeferred<{ cancelled: boolean }>();
    const { identity } = setupRequest({
      "tools.github.authorize.start": () => start.promise,
      "tools.github.authorize.cancel": () => cancel.promise,
    });
    const view = mountSolid(() => <GitHubConnectionSetup identity={identity} />);
    flush();
    view.getByRole("button", { name: "Continue with GitHub" }).click();
    flush();
    expect(view.getByText("Requesting code…")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
    start.resolve(authorizationCode);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getByText("ABCD-1234")).toBeTruthy();
    view.getByRole("button", { name: "Cancel" }).click();
    flush();
    expect(view.getByText("Requesting cancellation…")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
    cancel.resolve({ cancelled: true });
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getByRole("button", { name: "Continue with GitHub" })).toBeTruthy();
  });

  it("retires the owned status request when its view unmounts", async () => {
    const pending = createDeferred<ReturnType<typeof availableStatus>>();
    const client = createTestGatewayClient(vi.fn().mockReturnValue(pending.promise));
    let identity!: ReturnType<typeof createGitHubIdentityView>;
    const view = mountSolid(() => {
      identity = createGitHubIdentityView();
      return <GitHubIdentity identity={identity} onOpenConnections={vi.fn()} />;
    });
    flush();
    identity.sync({
      client,
      connected: true,
      permissionsReady: true,
      target: sharedTarget(),
      statusReadable: true,
      configurable: true,
      authorizable: true,
      clientRevision: 1,
    });
    let retired = false;
    const reading = identity.verify()?.then(() => {
      retired = true;
    });
    flush();
    view.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(retired).toBe(true);
    pending.resolve(availableStatus("system"));
    await reading;
  });

  it("shows a failed status read and clears it while retrying", async () => {
    const first = createDeferred<ReturnType<typeof availableStatus>>();
    const retry = createDeferred<ReturnType<typeof availableStatus>>();
    const { identity } = setupRequest(
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise),
    );
    const view = mountSolid(() => (
      <GitHubIdentity identity={identity} onOpenConnections={vi.fn()} />
    ));
    const reading = identity.verify();
    flush();
    expect(view.getByText("Checking connection…")).toBeTruthy();
    first.reject(new Error("Synthetic GitHub status unavailable"));
    await expect(reading).rejects.toThrow("Synthetic GitHub status unavailable");
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getByRole("alert").textContent).toContain("Synthetic GitHub status unavailable");
    expect(view.getByText("Connection status unavailable")).toBeTruthy();
    identity.showPatFallback();
    await identity.configure();
    flush();
    expect(view.getByRole("alert").textContent).toContain(
      "Paste a fine-grained personal access token first.",
    );
    view.getByRole("button", { name: "Verify" }).click();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByText("Checking connection…")).toBeTruthy();
    retry.resolve(availableStatus("system"));
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getByText("@managed-user")).toBeTruthy();
    expect(view.getByText("Verified")).toBeTruthy();
  });

  it("shows one shared error when the other identity read is still pending", async () => {
    const personal = createDeferred();
    const system = createDeferred();
    const view = mountSolid(() => (
      <GitHubConnectionError
        error={null}
        completion={personal.promise}
        secondaryCompletion={system.promise}
      />
    ));
    system.reject(new Error("Synthetic shared GitHub failure"));
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getAllByRole("alert")).toHaveLength(1);
    expect(view.getByRole("alert").textContent).toContain("Synthetic shared GitHub failure");
    personal.resolve();
  });

  it("retires saving presentation when a pending PAT command loses its scope", async () => {
    const oldSecret = createDeferred<unknown>();
    const newSecret = createDeferred<unknown>();
    const secrets = [oldSecret, newSecret];
    const { identity, sync } = setupRequest(
      async (method) => {
        if (method === "secrets.store.set") {
          return secrets.shift()!.promise;
        }
        if (method === "tools.github.configure") {
          return { ...availableStatus(), agentId: "replacement" };
        }
        return { ok: true };
      },
      { mutation: true, context: { scope: "agent" } },
    );
    identity.showPatFallback();
    identity.setDraft("token", "synthetic-first-token");
    const view = mountSolid(() => (
      <GitHubIdentity identity={identity} onOpenConnections={vi.fn()} />
    ));
    const oldSaving = identity.configure();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    sync({ agentId: "replacement" });
    await oldSaving;
    await vi.advanceTimersByTimeAsync(0);
    identity.showPatFallback();
    identity.setDraft("token", "synthetic-new-token");
    flush();
    const saving = identity.configure();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    oldSecret.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(identity.read().status).toBeNull();
    newSecret.resolve({ ok: true });
    await saving;
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(view.queryByRole("button", { name: "Saving…" })).toBeNull();
  });

  it("leaves the GitHub panel while its admitted PAT command remains pending", async () => {
    const stored = createDeferred<unknown>();
    const request = vi.fn(async (method: string) =>
      method === "secrets.store.set" ? stored.promise : availableStatus("system"),
    );
    const client = createTestGatewayClient(request);
    let identity!: ReturnType<typeof createGitHubIdentityView>;
    const router = createRouter({
      routes: [
        definePage({
          id: "github",
          path: "/github",
          component: () => ({
            renderSolid: () => {
              identity = createGitHubIdentityView({
                runExternalMutation: createMutationRunner(client),
              });
              return <GitHubIdentity identity={identity} onOpenConnections={vi.fn()} />;
            },
          }),
        }),
        definePage({
          id: "destination",
          path: "/destination",
          component: () => ({
            renderSolid: () => (
              <section aria-label="Destination body">The replacement route is ready.</section>
            ),
          }),
        }),
      ],
    });
    const view = mountSolid(() => (
      <button onClick={() => void router.navigate("destination", {})}>Open destination</button>
    ));
    const outlet = mountRouterOutlet({ router });
    const routed = getQueriesForElement(outlet);
    onTestFinished(() => {
      stored.resolve({ ok: true });
      outlet.dispose();
      view.unmount();
      router.stop();
    });
    await router.navigate("github", {});
    await settleRouterOutlet(outlet);
    flush();
    identity.sync({
      client,
      connected: true,
      permissionsReady: true,
      target: sharedTarget(),
      statusReadable: true,
      configurable: true,
      authorizable: true,
      clientRevision: 1,
    });
    identity.showPatFallback();
    flush();
    const input = routed.getByLabelText("Fine-grained PAT");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected PAT input");
    }
    input.value = "synthetic-navigation-token";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    routed.getByRole("button", { name: "Save Identity" }).click();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    let destination: HTMLElement | undefined;
    try {
      expect(routed.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
      expect(routed.getByRole("button", { name: "Verify" })).toHaveProperty("disabled", true);
      view.getByRole("button", { name: "Open destination" }).click();
      await vi.advanceTimersByTimeAsync(0);
      flush();
      destination = routed.getByRole("region", { name: "Destination body" });
      expect(destination.textContent).toBe("The replacement route is ready.");
      expect(outlet.querySelector("openclaw-github-identity")).toBeNull();
      expect(routed.queryByLabelText("Fine-grained PAT")).toBeNull();
      expect(routed.queryByRole("button", { name: "Saving…" })).toBeNull();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["secrets.store.set"]);
    } finally {
      stored.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "secrets.store.set",
      "secrets.store.delete",
    ]);
    expect(identity.read().status).toBeNull();
    expect(routed.getByRole("region", { name: "Destination body" })).toBe(destination);
    expect(outlet.querySelector("openclaw-github-identity")).toBeNull();
    expect(routed.queryByLabelText("Fine-grained PAT")).toBeNull();
  });

  it("retires pending authorization-code copying only when its payload changes", async () => {
    const pending = createDeferred();
    writeText.mockReturnValueOnce(pending.promise);
    type AuthorizationCode = Extract<GitHubAuthorizationState, { userCode: string }>;
    let updateAuthorization: (patch: Partial<AuthorizationCode>) => void = () => {};
    const view = mountSolid(() => {
      const [authorization, setAuthorization] = createSignal<AuthorizationCode>({
        phase: "code",
        requestId: "github-device-test",
        userCode: "first",
        verificationUri: "https://github.com/login/device",
        expiresInMs: 60_000,
        pollAfterMs: 5_000,
        displayExpiresAtMs: 70_000,
      });
      updateAuthorization = (patch) => setAuthorization((value) => ({ ...value, ...patch }));
      const fixture = githubIdentityViewFixture({ authorizable: true, connectionReady: true });
      const identity = {
        ...fixture,
        read: () => ({ ...fixture.read(), authorization: authorization() }),
      };
      return <GitHubConnectionSetup identity={identity} />;
    });
    const button = view.container.querySelector<HTMLButtonElement>(".github-device-code + button")!;
    button.click();
    expect(writeText).toHaveBeenCalledOnce();
    updateAuthorization({ phase: "pending" });
    flush();
    expect(view.container.querySelector(".github-device-code + button")).toBe(button);
    expect(view.getByText("Waiting for approval…")).toBeTruthy();
    updateAuthorization({ userCode: "second" });
    flush();
    const current = view.container.querySelector<HTMLButtonElement>(
      ".github-device-code + button",
    )!;
    expect(current).not.toBe(button);
    expect(current.disabled).toBe(false);
    pending.reject(new Error("Synthetic clipboard rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback).not.toHaveBeenCalled();
    expect(current.dataset.copyState).toBeUndefined();
    current.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
    expect(current.dataset.copyState).toBe("copied");
  });

  it("announces authorization-code copy outcomes in a status region", async () => {
    const authorization: Extract<GitHubAuthorizationState, { userCode: string }> = {
      phase: "code",
      requestId: "github-device-test",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInMs: 60_000,
      pollAfterMs: 5_000,
      displayExpiresAtMs: 70_000,
    };
    const fixture = githubIdentityViewFixture({ authorizable: true, connectionReady: true });
    const identity = { ...fixture, read: () => ({ ...fixture.read(), authorization }) };
    const view = mountSolid(() => <GitHubConnectionSetup identity={identity} />);
    const statusText = () =>
      [...view.container.querySelectorAll('.github-device-code ~ [role="status"]')].map(
        (node) => node.textContent,
      );
    const button = view.container.querySelector<HTMLButtonElement>(".github-device-code + button")!;
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(statusText()).toEqual(["Copied!"]);

    await vi.advanceTimersByTimeAsync(1500);
    writeText.mockRejectedValueOnce(new Error("Synthetic clipboard rejection"));
    fallback.mockReturnValueOnce(false);
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(statusText()).toEqual(["Copy failed"]);
  });

  it("keeps the focused PAT field across draft and mutation updates", async () => {
    const stored = createDeferred<unknown>();
    // SAFETY: this view test exercises only the browser client's request boundary.
    const client = {
      request: vi.fn(async (method: string) =>
        method === "secrets.store.set" ? stored.promise : { ok: true },
      ),
    } as unknown as GatewayBrowserClient;
    const identity = createGitHubIdentityForTest({
      runExternalMutation: async () => ({
        ok: false,
        reason: "unavailable",
        error: "Not dispatched in this view test.",
      }),
    });
    identity.sync({
      client,
      connected: true,
      permissionsReady: true,
      clientRevision: 1,
      target: {
        kind: "shared",
        scope: "agent",
        agentId: "main",
        config: {},
        profileId: "profile-a",
      },
      statusReadable: true,
      configurable: true,
      authorizable: true,
    });
    identity.showPatFallback();
    const view = mountSolid(() => (
      <GitHubIdentity identity={identity} onOpenConnections={vi.fn()} />
    ));
    const input = view.container.querySelector<HTMLInputElement>(".settings-secret input")!;
    input.focus();
    input.value = "synthetic-pat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(identity.read().draft.token).toBe("synthetic-pat");
    expect(view.container.querySelector(".settings-secret input")).toBe(input);
    expect(document.activeElement).toBe(input);
    const saving = identity.configure();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("synthetic-pat");
    expect(view.container.querySelector(".settings-secret input")).toBe(input);
    identity.dispose();
    stored.resolve({ ok: true });
    await saving;
  });
});
