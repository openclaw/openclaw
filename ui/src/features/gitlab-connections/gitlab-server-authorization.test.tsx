/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { GitLabServerAuthorization } from "./gitlab-server-authorization.tsx";

it("submits the entered server URL rather than silently using the configured default", () => {
  const onContinue = vi.fn();
  const screen = mountSolid(() => (
    <GitLabServerAuthorization
      issuer="https://gitlab.example.test"
      disabled={false}
      title="GitLab authorization"
      description="Connect your account."
      onContinue={onContinue}
    />
  ));
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "GitLab server URL" });
  expect(input.value).toBe("https://gitlab.example.test");
  input.value = "https://another.example.test";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  screen.getByRole<HTMLButtonElement>("button", { name: "Continue with GitLab" }).click();
  expect(onContinue).toHaveBeenCalledWith("https://another.example.test");
  screen.unmount();
});

it("resets an edited server draft when the configured issuer changes", () => {
  let replaceIssuer: (value: string) => void = () => {};
  const screen = mountSolid(() => {
    const [issuer, setIssuer] = createSignal("https://first.example.test");
    replaceIssuer = setIssuer;
    return (
      <GitLabServerAuthorization
        issuer={issuer()}
        disabled={false}
        title="GitLab authorization"
        description="Connect your account."
        onContinue={() => {}}
      />
    );
  });
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "GitLab server URL" });
  input.value = "https://draft.example.test";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(input.value).toBe("https://draft.example.test");
  replaceIssuer("https://second.example.test");
  flush();
  expect(input.value).toBe("https://second.example.test");
  screen.unmount();
});

it("preserves an entered URL when unrelated connection status refreshes", () => {
  let refreshStatus: () => void = () => {};
  const screen = mountSolid(() => {
    const [status, setStatus] = createSignal({ issuer: "https://first.example.test", busy: false });
    refreshStatus = () => setStatus({ issuer: "https://first.example.test", busy: false });
    return (
      <GitLabServerAuthorization
        issuer={status().issuer}
        disabled={status().busy}
        title="GitLab authorization"
        description="Connect your account."
        onContinue={refreshStatus}
      />
    );
  });
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "GitLab server URL" });
  input.value = "https://draft.example.test";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  screen.getByRole<HTMLButtonElement>("button", { name: "Continue with GitLab" }).click();
  flush();
  expect(input.value).toBe("https://draft.example.test");
  screen.unmount();
});
