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
    connected: true,
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
});
