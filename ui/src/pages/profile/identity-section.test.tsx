/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { IdentitySection } from "./identity-section.tsx";

type IdentitySectionProps = Parameters<typeof IdentitySection>[0];

const PROFILE: UserProfile = {
  id: "profile-1",
  displayName: "Ada Lovelace",
  avatarMime: "image/png",
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["ada@example.test", "ada@work.test"],
  githubIdentity: null,
  hasAvatar: true,
};

function createProps(overrides: Partial<IdentitySectionProps> = {}): IdentitySectionProps {
  return {
    profile: PROFILE,
    avatarUrl: "/api/users/profile-1/avatar?v=2",
    displayName: "Ada Lovelace",
    gitCoauthorEnabled: false,
    busy: null,
    error: null,
    onDisplayNameInput: vi.fn(),
    onSaveDisplayName: vi.fn(),
    onAvatarSelect: vi.fn(),
    onGitCoauthorChange: vi.fn(),
    ...overrides,
  };
}

let unmount: (() => void) | undefined;
function mountIdentity(props: IdentitySectionProps, container: HTMLElement) {
  unmount?.();
  unmount = mountSolid(() => <IdentitySection {...props} />, { container }).unmount;
  flush();
}

describe("IdentitySection", () => {
  it("hides upload controls while preserving avatar display and name editing", () => {
    const base = createApplicationConfigCapability({ resourceBasePath: "" });
    const config = { ...base, current: { ...base.current, uploadsEnabled: true } };
    const props = createProps({ config, displayName: "Ada" });
    const container = document.createElement("div");
    mountIdentity(props, container);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    config.current.uploadsEnabled = false;
    Object.defineProperty(input, "files", { value: [new File(["avatar"], "avatar.png")] });
    input.dispatchEvent(new Event("change"));
    expect(props.onAvatarSelect).not.toHaveBeenCalled();
    mountIdentity(props, container);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.querySelector(".identity-avatar-control button")).toBeNull();
    expect(container.querySelector("openclaw-viewer-avatar")).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>(".identity-name-control input")?.disabled,
    ).toBe(false);
    container
      .querySelector(".identity-name-control")
      ?.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(props.onSaveDisplayName).toHaveBeenCalledOnce();
  });
  afterEach(() => {
    document.body.replaceChildren();
    setAvatarGatewayOrigin(null);
    vi.restoreAllMocks();
  });

  it("renders the resolved profile through settings rows and the shared avatar", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    mountIdentity(createProps(), container);
    const avatar = container.querySelector<HTMLElement>("openclaw-viewer-avatar");
    await vi.waitFor(async () => {
      await (avatar as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)
        ?.updateComplete;
      expect(avatar?.querySelector("img")?.getAttribute("src")).toBe(
        "/api/users/profile-1/avatar?v=2",
      );
    });

    expect(container.querySelector("#settings-profile-identity")).not.toBeNull();
    expect(
      [...container.querySelectorAll(".settings-row__title")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual([
      "Avatar",
      "Display name",
      "Linked emails",
      "GitHub account",
      "Git co-author credit",
    ]);
    expect(container.textContent).toContain("ada@example.test, ada@work.test");
    expect(container.querySelector(".settings-account")).toBeNull();
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Refresh to retry");
    const toggle = container.querySelector<HTMLInputElement>("input.settings-toggle__input");
    expect(toggle?.checked).toBe(false);
    expect(toggle?.hasAttribute("disabled")).toBe(true);
  });

  it("falls back to initials when no same-origin avatar route is available", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    mountIdentity(
      createProps({
        avatarUrl: null,
        profile: { ...PROFILE, emails: ["profile-preview@example.test"], hasAvatar: false },
      }),
      container,
    );
    const avatar = container.querySelector<HTMLElement>("openclaw-viewer-avatar") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;
    await avatar?.updateComplete;

    // The gateway route (userProfileAvatarUrl) serves the Gravatar fallback
    // server-side and stays same-origin under the Control UI CSP. When no route
    // is available — e.g. a cross-origin gateway returns null — the chip shows
    // deterministic initials rather than a CSP-blocked direct gravatar.com image.
    expect(avatar?.querySelector("img")).toBeNull();
    expect(avatar?.textContent?.trim()).toBe("AL");
  });

  it("forwards an allowlisted avatar file and resets the picker", () => {
    const onAvatarSelect = vi.fn();
    const container = document.createElement("div");
    mountIdentity(createProps({ onAvatarSelect }), container);

    const chooser = container.querySelector<HTMLButtonElement>(".identity-avatar-control .btn");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const clickInput = vi.spyOn(input!, "click");
    chooser?.click();
    expect(chooser?.type).toBe("button");
    expect(clickInput).toHaveBeenCalledOnce();

    const file = new File(["avatar"], "avatar.webp", { type: "image/webp" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(input?.accept).toBe("image/png,image/jpeg,image/webp");
    expect(input?.value).toBe("");
    expect(onAvatarSelect).toHaveBeenCalledWith(file);

    mountIdentity(createProps({ busy: "display-name" }), container);
    expect(
      container.querySelector<HTMLButtonElement>(".identity-avatar-control .btn")?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
  });

  it("shows verified GitHub identity and explicit co-author credit", () => {
    const onGitCoauthorChange = vi.fn();
    const container = document.createElement("div");
    mountIdentity(
      createProps({
        gitCoauthorEnabled: true,
        profile: {
          ...PROFILE,
          githubIdentity: {
            login: "octocat",
            profileUrl: "https://github.com/octocat",
            avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
          },
        },
        onGitCoauthorChange,
      }),
      container,
    );

    const account = container.querySelector<HTMLAnchorElement>(".settings-account");
    expect(account?.href).toBe("https://github.com/octocat");
    expect(account?.target).toBe("_blank");
    expect(account?.rel).toContain("noopener");
    expect(account?.querySelector("img")?.src).toBe(
      "https://avatars.githubusercontent.com/u/583231?v=4",
    );
    expect(container.querySelector(".identity-github-form")).toBeNull();
    expect(container.textContent).toContain("Verified from your GitHub-backed sign-in");
    expect(container.textContent).not.toContain("Disconnect");
    expect(container.textContent).toContain("public GitHub noreply address");
    expect(container.textContent).toContain("future commits only");
    const toggle = container.querySelector<HTMLInputElement>("input.settings-toggle__input");
    expect(toggle?.checked).toBe(true);
    expect(toggle?.hasAttribute("disabled")).toBe(false);
    toggle!.checked = false;
    toggle?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onGitCoauthorChange).toHaveBeenCalledWith(false);
  });

  it("explains personal GitHub sign-in for the shared owner without email or retry rows", () => {
    const container = document.createElement("div");
    mountIdentity(
      createProps({ profile: { ...PROFILE, id: "gateway-owner", emails: [] } }),
      container,
    );

    const descriptions = [...container.querySelectorAll(".settings-row__desc")].map((node) =>
      node.textContent?.trim(),
    );
    expect(descriptions).toContain(
      "GitHub-backed sign-in through Cloudflare Access or Tailscale Serve provides this identity.",
    );
    expect(descriptions).toContain(
      "Requires GitHub-backed sign-in through Cloudflare Access or Tailscale Serve.",
    );
    expect(container.textContent).not.toContain("Linked emails");
    expect(container.textContent).not.toContain("Refresh to retry");
    const toggle = container.querySelector<HTMLInputElement>("input.settings-toggle__input");
    expect(toggle?.checked).toBe(false);
    expect(toggle?.hasAttribute("disabled")).toBe(true);
  });

  it("reports mutation errors without inventing another settings surface", () => {
    const container = document.createElement("div");
    mountIdentity(createProps({ error: "Save failed" }), container);

    expect(container.querySelector('[role="alert"]')?.textContent?.trim()).toBe("Save failed");
    expect(container.querySelectorAll(".settings-group")).toHaveLength(1);
  });
});
