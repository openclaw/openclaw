import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { GitHubAuthorizationState } from "./github-identity-shared.ts";
import { GitHubConnectionSetup, GitHubIdentity } from "./github-identity-view.tsx";
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
    flush();
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("synthetic-pat");
    expect(view.container.querySelector(".settings-secret input")).toBe(input);
    identity.dispose();
    stored.resolve({ ok: true });
    await saving;
  });
});
