/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { IdentitySection, type IdentitySectionProps } from "./identity-section.tsx";
import { modelAccountProfile } from "./profile-page.test-support.tsx";

const PROFILE = { ...modelAccountProfile, displayName: "Ada Lovelace" };

function mountIdentity(overrides: Partial<IdentitySectionProps> = {}) {
  const props: IdentitySectionProps = {
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
  unmount?.();
  const view = mountSolid(() => <IdentitySection {...props} />);
  ({ container, unmount } = view);
  flush();
  return props;
}

let unmount: (() => void) | undefined;
let container: HTMLElement;
const fileInput = () => container.querySelector<HTMLInputElement>('input[type="file"]');
const avatarButton = () =>
  container.querySelector<HTMLButtonElement>(".identity-avatar-control .btn");
it("hides upload controls while preserving avatar display and name editing", () => {
  const base = createApplicationConfigCapability({ resourceBasePath: "" });
  const config = { ...base, current: { ...base.current, uploadsEnabled: true } };
  const props = mountIdentity({ config, displayName: "Ada" });
  const input = fileInput()!;
  config.current.uploadsEnabled = false;
  Object.defineProperty(input, "files", { value: [new File(["avatar"], "avatar.png")] });
  input.dispatchEvent(new Event("change"));
  expect(props.onAvatarSelect).not.toHaveBeenCalled();
  mountIdentity(props);
  expect([fileInput(), avatarButton()]).toEqual([null, null]);
  expect(container.querySelector("openclaw-viewer-avatar")).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>(".identity-name-control input")?.disabled).toBe(
    false,
  );
  container
    .querySelector(".identity-name-control")
    ?.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
  expect(props.onSaveDisplayName).toHaveBeenCalledOnce();
});
afterEach(() => {
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

it("falls back to initials when no same-origin avatar route is available", async () => {
  mountIdentity({
    avatarUrl: null,
    profile: { ...PROFILE, emails: ["profile-preview@example.test"], hasAvatar: false },
  });
  const avatar = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
    "openclaw-viewer-avatar",
  );
  await avatar?.updateComplete;

  // No route means initials, not a CSP-blocked direct Gravatar request.
  expect(avatar?.querySelector("img")).toBeNull();
  expect(avatar?.textContent?.trim()).toBe("AL");
});

it("forwards an allowlisted avatar file and resets the picker", () => {
  const { onAvatarSelect } = mountIdentity();

  const chooser = avatarButton();
  const input = fileInput();
  const clickInput = vi.spyOn(input!, "click");
  chooser?.click();
  expect(chooser?.type).toBe("button");
  expect(clickInput).toHaveBeenCalledOnce();

  const file = new File(["avatar"], "avatar.webp", { type: "image/webp" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input?.dispatchEvent(new Event("change", { bubbles: true }));

  expect(input).toMatchObject({ accept: "image/png,image/jpeg,image/webp", value: "" });
  expect(onAvatarSelect).toHaveBeenCalledWith(file);

  mountIdentity({ busy: "display-name" });
  expect([avatarButton()?.disabled, fileInput()?.disabled]).toEqual([true, true]);
});

it("explains personal GitHub sign-in for the shared owner without email or retry rows", () => {
  mountIdentity({ profile: { ...PROFILE, id: "gateway-owner", emails: [] } });

  const descriptions = [...container.querySelectorAll(".settings-row__desc")].map((node) =>
    node.textContent?.trim(),
  );
  expect(descriptions).toEqual(
    expect.arrayContaining([
      "GitHub-backed sign-in through Cloudflare Access or Tailscale Serve provides this identity.",
      "Requires GitHub-backed sign-in through Cloudflare Access or Tailscale Serve.",
    ]),
  );
  expect(container.textContent).not.toContain("Linked emails");
  expect(container.textContent).not.toContain("Refresh to retry");
  const toggle = container.querySelector<HTMLInputElement>("input.settings-toggle__input");
  expect(toggle?.checked).toBe(false);
  expect(toggle?.hasAttribute("aria-disabled")).toBe(true);
});
