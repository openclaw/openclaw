/* @vitest-environment jsdom */
import type { JSX } from "@solidjs/web";
import { createSignal, flush, Show } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import type { AgentIdentity } from "../lib/identity-avatar-view.ts";
import type { IdentityAvatarInput } from "../lib/identity-avatar.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import {
  IdentityAvatarImage,
  createIdentityAvatarPresentation,
} from "./solid/identity-avatar-image.tsx";
import { useIdentityAvatarView } from "./solid/identity-avatar-view.ts";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";

const gateway = "https://gateway.example.test";
const imageResponse = () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });

function mountAvatar<T>(initial: T, render: (value: () => T) => JSX.Element, frameClass: string) {
  const [input, setInput] = createSignal<T>(() => initial);
  const [presented, setPresented] = createSignal(true);
  const mounted = mountSolid(() => <Show when={presented()}>{render(input)}</Show>);
  const image = () => mounted.container.querySelector<HTMLImageElement>("img");
  return {
    ...mounted,
    image,
    frame: () => mounted.container.querySelector(frameClass),
    update: (next: T) => {
      setInput(() => next);
      flush();
    },
    present: (next: boolean) => {
      setPresented(next);
      flush();
    },
    loaded: (src: string) => vi.waitFor(() => expect(image()?.getAttribute("src")).toBe(src)),
  };
}
const mountImage = (identity: IdentityAvatarInput) =>
  mountAvatar(identity, (value) => <ProfileImage identity={value()} />, ".test-avatar");
const mountAgent = (agent: AgentIdentity) =>
  mountAvatar(agent, (value) => <AgentIdentityAvatar agent={value()} />, ".identity-avatar--agent");

function profile(revision = 1, name = "Ada Lovelace") {
  return {
    id: "profile-ada",
    name,
    profileAvatarUrl: `/api/users/profile-ada/avatar?v=${revision}`,
  };
}

function ProfileImage(props: { identity: IdentityAvatarInput }) {
  const view = useIdentityAvatarView(() => props.identity);
  const presentation = createIdentityAvatarPresentation(view);
  return (
    <span class={["test-avatar", presentation.classes()]} data-avatar-state={presentation.state()}>
      <IdentityAvatarImage
        view={view()}
        onStateChange={presentation.onStateChange}
        class="test-avatar__image"
        alt="Ada Lovelace"
        ariaHidden
      />
    </span>
  );
}

function mockImages(urls: string | string[], token = "avatar-token") {
  setAvatarGatewayOrigin(gateway, [token]);
  const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
  const objectUrl = vi.spyOn(URL, "createObjectURL");
  if (typeof urls === "string") {
    objectUrl.mockReturnValue(urls);
  } else {
    for (const url of urls) {
      objectUrl.mockReturnValueOnce(url);
    }
  }
  return { fetchAvatar, revoke: vi.spyOn(URL, "revokeObjectURL") };
}

afterEach(() => {
  cleanupSolid();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-openclaw-control-ui-build-id");
});

it.each(["profile", "agent"] as const)(
  "refreshes mounted %s images after credential changes",
  async (kind) => {
    const { fetchAvatar, revoke } = mockImages(
      ["blob:old-identity", "blob:new-identity"],
      "old-token",
    );
    const url = kind === "profile" ? "/api/users/ada/avatar" : "/avatar/ada";
    const view =
      kind === "profile"
        ? mountImage({ id: "ada", name: "Ada", profileAvatarUrl: url })
        : mountAgent({ id: "ada", name: "Ada", avatar: url, textAvatar: "A" });
    await view.loaded("blob:old-identity");
    const image = view.image();
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    if (kind === "profile") {
      expect([image?.alt, image?.getAttribute("aria-hidden")]).toEqual(["Ada Lovelace", "true"]);
    }
    setAvatarGatewayOrigin(gateway, ["new-token"]);
    await view.loaded("blob:new-identity");
    expect(view.image()).toBe(image);
    expect(revoke).toHaveBeenCalledWith("blob:old-identity");
    expect(fetchAvatar).toHaveBeenLastCalledWith(
      `${gateway}${url}`,
      expect.objectContaining({ headers: { Authorization: "Bearer new-token" } }),
    );
  },
);

it("does not restore retired Gateway images on remount", async () => {
  const { fetchAvatar, revoke } = mockImages("blob:old-gateway", "old-token");
  const view = mountImage({
    id: "profile-ada",
    name: "Ada",
    profileAvatarUrl: "https://gateway.example.test/api/users/profile-ada/avatar?v=1",
  });
  await view.loaded("blob:old-gateway");
  view.present(false);
  setAvatarGatewayOrigin("https://replacement.example.test", ["new-token"]);
  view.present(true);
  expect(view.image()?.getAttribute("src")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:old-gateway");
  expect(fetchAvatar).toHaveBeenCalledOnce();
});

it("retains pending images through replacement/remount under pressure", async () => {
  setAvatarGatewayOrigin(gateway, ["avatar-token"]);
  const avatar = createDeferred<Response>();
  const pressure = createDeferred<Response>();
  let requests = 0;
  const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/avatar/pending-")) {
      return pressure.promise;
    }
    return ++requests === 1 ? avatar.promise : Promise.resolve(imageResponse());
  });
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:view-${sequence++}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const identity = profile(1, "Ada");
  const first = mountImage(identity);
  const second = mountImage(identity);
  const pressureLoads = Array.from({ length: 128 }, (_, index) =>
    Promise.resolve(resolveAvatarImageUrl(`/avatar/pending-${index}?v=1`)),
  );
  first.unmount();
  avatar.resolve(imageResponse());
  try {
    await second.loaded("blob:view-0");
    second.image()?.dispatchEvent(new Event("load"));
    expect(revoke).not.toHaveBeenCalledWith("blob:view-0");
    second.present(false);
    expect(revoke).toHaveBeenCalledWith("blob:view-0");
    second.present(true);
    await second.loaded("blob:view-1");
    second.update({ ...identity });
    expect(revoke).not.toHaveBeenCalledWith("blob:view-1");
    expect(requests).toBe(2);
    const image = second.image()!;
    second.update({ ...identity, profileAvatarUrl: "/api/users/profile-ada/avatar?v=2" });
    expect(second.frame()?.classList.contains("is-pending")).toBe(true);
    await second.loaded("blob:view-2");
    expect(second.image()).toBe(image);
    for (const [event, fallback] of [
      ["error", true],
      ["load", false],
    ] as const) {
      image.dispatchEvent(new Event(event));
      flush();
      expect(second.frame()?.classList.contains("is-fallback")).toBe(fallback);
    }
    expect(second.frame()?.getAttribute("data-avatar-state")).toBe("loaded");
    expect(revoke).toHaveBeenCalledWith("blob:view-1");
    expect(revoke).not.toHaveBeenCalledWith("blob:view-2");
    expect(fetchAvatar).toHaveBeenCalledTimes(131);
  } finally {
    second.unmount();
    pressure.resolve(new Response(null, { status: 404 }));
    await Promise.all(pressureLoads);
  }
});
it("remounts public images loaded without a load event or authenticated fetching", () => {
  setAvatarGatewayOrigin(globalThis.location.origin, ["avatar-token"], "/control");
  const fetchAvatar = vi.spyOn(globalThis, "fetch");
  const view = mountAgent({ id: "main", avatar: "/favicon.svg", textAvatar: "🦀" });
  expect(view.image()?.getAttribute("src")).toBe("/favicon.svg");
  view.present(false);
  view.present(true);
  expect(view.image()?.getAttribute("src")).toBe("/favicon.svg");
  expect(view.frame()?.classList.contains("is-pending")).toBe(false);
  expect(view.frame()?.getAttribute("data-avatar-state")).toBe("loaded");
  expect(fetchAvatar).not.toHaveBeenCalled();
});

it("updates reserved avatars on theme publication", async () => {
  const previous = currentThemeBranding();
  onTestFinished(() => setCurrentThemeBranding(previous));
  setCurrentThemeBranding(resolveThemeBranding(undefined));
  const view = mountAgent({ id: "openclaw", name: "Assistant" });
  expect(view.image()?.getAttribute("src")).toContain("favicon.svg");
  setCurrentThemeBranding(
    resolveThemeBranding({
      brandIcon: "compass",
      artwork: { icons: { compass: { url: "data:image/svg+xml,compass" } } },
    }),
  );
  flush();
  await vi.waitFor(() =>
    expect(view.container.querySelector("openclaw-theme-brand-icon")).not.toBeNull(),
  );
  setCurrentThemeBranding(resolveThemeBranding(undefined));
  flush();
  expect(view.container.querySelector("openclaw-theme-brand-icon")).toBeNull();
  expect(view.image()?.getAttribute("src")).toContain("favicon.svg");
});

it("uses UI mount/build for the remote Gateway's system mark", () => {
  setAvatarGatewayOrigin(gateway, ["avatar-token"]);
  vi.stubGlobal("__OPENCLAW_CONTROL_UI_BASE_PATH__", "/control");
  document.documentElement.setAttribute("data-openclaw-control-ui-build-id", "build-1");
  const view = mountAgent({ id: "openclaw" });
  expect(view.image()?.getAttribute("src")).toBe("/control/favicon.svg?v=build-1");
});
