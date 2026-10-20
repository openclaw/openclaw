import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  authorizationCode,
  setupRequest,
  forbidSharedMutation,
} from "./github-identity-harness.test-support.ts";
import type { GitHubAuthorizationState } from "./github-identity-shared.ts";
import { GitHubConnectionSetup, GitHubIdentity } from "./github-identity-view.tsx";
import { githubIdentityViewFixture } from "./github-identity.test-support.ts";

const writeText = vi.fn<(text: string) => Promise<void>>();
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  vi.useRealTimers();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("retires pending authorization-code copying only when its payload changes", async () => {
  const pending = createDeferred();
  writeText.mockReturnValueOnce(pending.promise);
  type AuthorizationCode = Extract<GitHubAuthorizationState, { userCode: string }>;
  let updateAuthorization: (patch: Partial<AuthorizationCode>) => void = () => {};
  const view = mountSolid(() => {
    const [authorization, setAuthorization] = createSignal<AuthorizationCode>({
      ...authorizationCode,
      phase: "code",
      userCode: "first",
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
  const copyButton = () =>
    view.container.querySelector<HTMLButtonElement>(".github-device-code + button")!;
  const button = copyButton();
  button.click();
  updateAuthorization({ phase: "pending" });
  flush();
  expect(copyButton()).toBe(button);
  expect(view.getByText("Waiting for approval…")).toBeTruthy();
  updateAuthorization({ userCode: "second" });
  flush();
  const current = copyButton();
  expect(current).not.toBe(button);
  expect(current.disabled).toBe(false);
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  current.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(writeText.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
});

it("keeps the focused PAT field and fallback across draft and mutation updates", async () => {
  const stored = createDeferred<unknown>();
  const { identity } = setupRequest(
    async (method) => (method === "secrets.store.set" ? stored.promise : { ok: true }),
    {
      runExternalMutation: forbidSharedMutation,
      context: { scope: "agent" },
    },
  );
  identity.showPatFallback();
  const view = mountSolid(() => <GitHubIdentity identity={identity} onOpenConnections={vi.fn()} />);
  const input = view.container.querySelector<HTMLInputElement>(".settings-secret input")!;
  input.focus();
  input.value = "synthetic-pat";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(identity.read().draft.token).toBe("synthetic-pat");
  expect(view.container.querySelector(".settings-secret input")).toBe(input);
  expect(document.activeElement).toBe(input);
  const saving = identity.configure();
  identity.hidePatFallback();
  flush();
  expect(identity.read().patVisible).toBe(true);
  expect(input).toMatchObject({ disabled: true, value: "synthetic-pat" });
  expect(view.container.querySelector(".settings-secret input")).toBe(input);
  identity.dispose();
  stored.resolve({ ok: true });
  await saving;
});
