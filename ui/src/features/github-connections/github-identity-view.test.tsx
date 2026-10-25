import { createRouter, definePage } from "@openclaw/uirouter";
import { getQueriesForElement } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { mountRouterOutlet, settleRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { createGitHubIdentityView } from "../../lib/reactive/domain-github-identity.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
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
import { githubIdentityViewFixture } from "./github-identity.test-support.ts";

const writeText = vi.fn<(text: string) => Promise<void>>();
const fallback = vi.fn(() => true);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  flush();
}

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
  restorePropertyDescriptor(navigator, "clipboard", clipboardDescriptor);
  restorePropertyDescriptor(document, "execCommand", execCommandDescriptor);
});

describe("GitHub identity view", () => {
  it("shows device request and cancellation progress before the server settles", async () => {
    const start = createDeferred<typeof authorizationCode>();
    const cancel = createDeferred<{ cancelled: boolean }>();
    const { identity, request } = setupRequest({
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
    await settle();
    expect(view.getByText("ABCD-1234")).toBeTruthy();
    view.getByRole("button", { name: "Cancel" }).click();
    flush();
    expect(view.getByText("Requesting cancellation…")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
    await identity.cancelAuthorization();
    expect(
      request.mock.calls.filter(([method]) => method === "tools.github.authorize.cancel"),
    ).toEqual([["tools.github.authorize.cancel", { requestId: authorizationCode.requestId }]]);
    cancel.resolve({ cancelled: true });
    await settle();
    expect(identity.read().authorization).toEqual({ phase: "idle" });
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
    expect(view.getByText("Checking connection…")).toBeTruthy();
    view.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(retired).toBe(true);
    pending.resolve(availableStatus("system"));
    await reading;
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
    await settle();
    expect(view.getAllByRole("alert")).toHaveLength(1);
    expect(view.getByRole("alert").textContent).toContain("Synthetic shared GitHub failure");
    personal.resolve();
  });

  it("preserves the focused PAT draft while saving and retires it when its scope changes", async () => {
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
    const view = mountSolid(() => (
      <GitHubIdentity identity={identity} onOpenConnections={vi.fn()} />
    ));
    await identity.configure();
    flush();
    expect(view.getByRole("alert").textContent).toContain(
      "Paste a fine-grained personal access token first.",
    );
    const input = view.container.querySelector<HTMLInputElement>(".settings-secret input")!;
    input.focus();
    input.value = "synthetic-first-token";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(identity.read().draft.token).toBe("synthetic-first-token");
    expect(view.container.querySelector(".settings-secret input")).toBe(input);
    expect(document.activeElement).toBe(input);
    const oldSaving = identity.configure();
    await settle();
    expect(view.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    expect(input).toMatchObject({ disabled: true, value: "synthetic-first-token" });
    expect(view.container.querySelector(".settings-secret input")).toBe(input);
    sync({ agentId: "replacement" });
    await oldSaving;
    await vi.advanceTimersByTimeAsync(0);
    identity.showPatFallback();
    identity.setDraft("token", "synthetic-new-token");
    flush();
    const saving = identity.configure();
    await settle();
    expect(view.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    oldSecret.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(identity.read().status).toBeNull();
    newSecret.resolve({ ok: true });
    await saving;
    await settle();
    expect(view.queryByRole("button", { name: "Saving…" })).toBeNull();
    expect(view.getByText("@managed-user")).toBeTruthy();
    expect(view.getByText("Verified")).toBeTruthy();
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
    await settle();
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
    type Code = Extract<GitHubAuthorizationState, { userCode: string }>;
    let update: (patch: Partial<Code>) => void = () => {};
    const view = mountSolid(() => {
      const [authorization, setAuthorization] = createSignal<Code>({
        ...authorizationCode,
        phase: "code",
        userCode: "first",
        displayExpiresAtMs: 70_000,
      });
      update = (patch) => setAuthorization((value) => ({ ...value, ...patch }));
      const fixture = githubIdentityViewFixture({ authorizable: true, connectionReady: true });
      const identity = {
        ...fixture,
        read: () => ({ ...fixture.read(), authorization: authorization() }),
      };
      return <GitHubConnectionSetup identity={identity} />;
    });
    const copyButton = () =>
      view.container.querySelector<HTMLButtonElement>(".github-device-code + button")!;
    const announcements = () =>
      [...view.container.querySelectorAll('.github-device-code ~ [role="status"]')].map(
        (node) => node.textContent,
      );
    const button = copyButton();
    button.click();
    expect(writeText).toHaveBeenCalledOnce();
    update({ phase: "pending" });
    flush();
    expect(copyButton()).toBe(button);
    expect(view.getByText("Waiting for approval…")).toBeTruthy();
    update({ userCode: "second" });
    flush();
    const current = copyButton();
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
    expect(announcements()).toEqual(["Copied!"]);
    await vi.advanceTimersByTimeAsync(1500);
    writeText.mockRejectedValueOnce(new Error("Synthetic clipboard rejection"));
    fallback.mockReturnValueOnce(false);
    current.click();
    await settle();
    expect(announcements()).toEqual(["Copy failed"]);
  });
});
