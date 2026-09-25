/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { resolveAvatarInitials } from "../lib/identity-avatar.ts";
import {
  renderAgentIdentityAvatar,
  identityAvatarClass,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
  type IdentityAvatarView,
} from "./identity-avatar-view.ts";

function renderAvatar(view: IdentityAvatarView, container: HTMLElement) {
  return render(
    html`<span class=${identityAvatarClass("test-avatar", view)}>
      ${renderIdentityAvatarImage({
        view,
        fallbackSelector: ".test-avatar",
        className: "test-avatar__image",
        alt: "Ada Lovelace",
        ariaHidden: true,
      })}
    </span>`,
    container,
  );
}

afterEach(() => {
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

describe("shared identity avatar view", () => {
  it.each(["/favicon.svg", "/control/assets/mascot.svg?v=build-1"])(
    "preserves the public image %s through reconnect without authenticated fetching",
    (url) => {
      setAvatarGatewayOrigin(globalThis.location.origin, ["avatar-token"], "/control");
      const fetchAvatar = vi.spyOn(globalThis, "fetch");
      const container = document.createElement("div");
      const part = render(
        renderAgentIdentityAvatar({ id: "main", avatar: url, textAvatar: "🦀" }),
        container,
      );
      expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
      part.setConnected(false);
      part.setConnected(true);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
      expect(fetchAvatar).not.toHaveBeenCalled();
      render(nothing, container);
    },
  );

  it("derives fallback initials and colors from the canonical user identity", () => {
    const identity = {
      id: "profile-riley",
      name: "Riley",
      username: "riley@example.test",
    };

    const view = resolveIdentityAvatarView(identity);

    expect(view.fallback).toEqual(resolveAvatarInitials(identity));
    expect(view.fallback.initials).toBe("R");
    expect(view.imageUrl).toBeNull();
    expect(view.pending).toBe(false);
  });

  it("keeps hostile avatar origins out of the shared authenticated renderer", () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const fetchAvatar = vi.spyOn(globalThis, "fetch");

    const view = resolveIdentityAvatarView({
      id: "profile-mallory",
      name: "Mallory",
      profileAvatarUrl: "https://evil.example/api/users/profile-mallory/avatar",
    });

    expect(view.fallback.initials).toBe("M");
    expect(view.imageUrl).toBeNull();
    expect(view.pending).toBe(false);
    expect(fetchAvatar).not.toHaveBeenCalled();
  });

  it("does not restore a retired Gateway's image when its view reconnects", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["old-token"]);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:old-gateway");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const container = document.createElement("div");
    const part = renderAvatar(
      resolveIdentityAvatarView({
        id: "profile-ada",
        name: "Ada",
        profileAvatarUrl: "/api/users/profile-ada/avatar?v=1",
      }),
      container,
    );
    const source = () => container.querySelector("img")?.getAttribute("src");
    await vi.waitFor(() => expect(source()).toBe("blob:old-gateway"));
    part.setConnected(false);
    setAvatarGatewayOrigin("https://replacement.example.test", ["new-token"]);
    part.setConnected(true);
    expect(source()).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:old-gateway");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    render(nothing, container);
  });

  it("shares authenticated loading and reconciles image fallback events", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-identity-avatar");

    const view = resolveIdentityAvatarView({
      id: "profile-ada",
      name: "Ada Lovelace",
      profileAvatarUrl: "/api/users/profile-ada/avatar?v=7",
    });
    const container = document.createElement("div");
    document.body.append(container);
    renderAvatar(view, container);

    const wrapper = container.querySelector<HTMLElement>(".test-avatar");
    expect(view.pending).toBe(true);
    expect(wrapper?.classList.contains("is-pending")).toBe(true);
    expect(wrapper?.classList.contains("is-fallback")).toBe(false);

    const image = await vi.waitFor(() => {
      const element = container.querySelector<HTMLImageElement>(".test-avatar__image");
      expect(element?.getAttribute("src")).toBe("blob:shared-identity-avatar");
      return element!;
    });
    expect(image.getAttribute("alt")).toBe("Ada Lovelace");
    expect(image.getAttribute("aria-hidden")).toBe("true");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
      expect.objectContaining({ headers: { Authorization: "Bearer avatar-token" } }),
    );

    image.dispatchEvent(new Event("load"));
    expect(wrapper?.classList.contains("is-fallback")).toBe(false);
    renderAvatar(
      resolveIdentityAvatarView({
        id: "profile-ada",
        name: "Ada Lovelace",
        profileAvatarUrl: "/api/users/profile-ada/avatar?v=7",
      }),
      container,
    );
    expect(container.querySelector("img")).toBe(image);
    expect(wrapper?.getAttribute("data-avatar-state")).toBe("loaded");

    image.dispatchEvent(new Event("error"));
    expect(wrapper?.classList.contains("is-fallback")).toBe(true);

    image.dispatchEvent(new Event("load"));
    expect(wrapper?.classList.contains("is-fallback")).toBe(false);
  });

  it("reuses its image element with a neutral placeholder while a newer revision loads", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:identity-avatar-v1")
      .mockReturnValueOnce("blob:identity-avatar-v2");

    const identity = { id: "profile-ada", name: "Ada Lovelace" };
    const container = document.createElement("div");
    document.body.append(container);
    renderAvatar(
      resolveIdentityAvatarView({
        ...identity,
        profileAvatarUrl: "/api/users/profile-ada/avatar?v=1",
      }),
      container,
    );

    const firstImage = await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>(".test-avatar__image");
      expect(image?.getAttribute("src")).toBe("blob:identity-avatar-v1");
      return image!;
    });
    firstImage.dispatchEvent(new Event("load"));

    renderAvatar(
      resolveIdentityAvatarView({
        ...identity,
        profileAvatarUrl: "/api/users/profile-ada/avatar?v=2",
      }),
      container,
    );
    expect(container.querySelector(".test-avatar")?.classList.contains("is-pending")).toBe(true);

    const secondImage = await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>(".test-avatar__image");
      expect(image?.getAttribute("src")).toBe("blob:identity-avatar-v2");
      return image!;
    });
    expect(secondImage).toBe(firstImage);

    secondImage.dispatchEvent(new Event("load"));
    expect(container.querySelector(".test-avatar")?.classList.contains("is-fallback")).toBe(false);
  });

  it("retains pending images independently through replacement and reconnect under pressure", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const avatar = createDeferred<Response>();
    const pressure = createDeferred<Response>();
    const response = () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    let avatarRequests = 0;
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/avatar/pending-")) {
        return pressure.promise;
      }
      avatarRequests += 1;
      return avatarRequests === 1 ? avatar.promise : Promise.resolve(response());
    });
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:view-${sequence++}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const identity = {
      id: "profile-ada",
      name: "Ada",
      profileAvatarUrl: "/api/users/profile-ada/avatar?v=1",
    };
    const first = document.body.appendChild(document.createElement("div"));
    const second = document.body.appendChild(document.createElement("div"));
    renderAvatar(resolveIdentityAvatarView(identity), first);
    const part = renderAvatar(resolveIdentityAvatarView(identity), second);
    const pressureLoads = Array.from({ length: 128 }, (_, index) =>
      Promise.resolve(resolveAvatarImageUrl(`/avatar/pending-${index}?v=1`)),
    );
    render(nothing, first);
    avatar.resolve(response());
    const image = () => second.querySelector<HTMLImageElement>("img");
    try {
      await vi.waitFor(() => expect(image()?.getAttribute("src")).toBe("blob:view-0"));
      image()?.dispatchEvent(new Event("load"));
      expect(revoke).not.toHaveBeenCalledWith("blob:view-0");
      part.setConnected(false);
      expect(revoke).toHaveBeenCalledWith("blob:view-0");
      part.setConnected(true);
      await vi.waitFor(() => expect(image()?.getAttribute("src")).toBe("blob:view-1"));
      renderAvatar(resolveIdentityAvatarView(identity), second);
      expect(image()?.getAttribute("src")).toBe("blob:view-1");
      expect(avatarRequests).toBe(2);
      renderAvatar(
        resolveIdentityAvatarView({
          ...identity,
          profileAvatarUrl: "/api/users/profile-ada/avatar?v=2",
        }),
        second,
      );
      await vi.waitFor(() => expect(image()?.getAttribute("src")).toBe("blob:view-2"));
      expect(revoke).toHaveBeenCalledWith("blob:view-1");
      expect(revoke).not.toHaveBeenCalledWith("blob:view-2");
      expect(fetchAvatar).toHaveBeenCalledTimes(131);
    } finally {
      render(nothing, first);
      render(nothing, second);
      pressure.resolve(new Response(null, { status: 404 }));
      await Promise.all(pressureLoads);
    }
  });
});

describe("shared agent avatar view", () => {
  it.each([false, true])(
    "hides an existing fallback as soon as an image is configured (authenticated=%s)",
    async (authenticated) => {
      const response = createDeferred<Response>();
      if (authenticated) {
        setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
        vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
      }
      const container = document.createElement("div");
      render(renderAgentIdentityAvatar({ id: "hydrated", textAvatar: "🦀" }), container);
      const wrapper = container.querySelector(".identity-avatar--agent")!;
      expect(wrapper.classList.contains("is-fallback")).toBe(true);
      render(
        renderAgentIdentityAvatar({ id: "hydrated", textAvatar: "🦀", avatar: "/avatar/hydrated" }),
        container,
      );
      expect(container.querySelector(".identity-avatar--agent")).toBe(wrapper);
      expect(wrapper.classList.contains("is-pending")).toBe(true);
      expect(wrapper.classList.contains("is-fallback")).toBe(false);
      response.resolve(new Response(null, { status: 404 }));
      if (authenticated) {
        await vi.waitFor(() => expect(wrapper.classList.contains("is-fallback")).toBe(true));
      }
      render(nothing, container);
    },
  );

  it.each([undefined, "🦀"])(
    "keeps a configured image neutral until it loads (%s)",
    (textAvatar) => {
      const container = document.createElement("div");
      const agent = { id: "pending", avatar: "/avatar/pending?v=1", textAvatar };
      const update = (className = "") =>
        render(renderAgentIdentityAvatar(agent, className), container);
      update();
      const wrapper = container.querySelector(".identity-avatar--agent")!;
      const image = container.querySelector("img")!;
      expect(wrapper.classList.contains("is-pending")).toBe(true);
      expect(wrapper.classList.contains("is-fallback")).toBe(false);
      image.dispatchEvent(new Event("load"));
      update("renamed-surface");
      expect(container.querySelector("img")).toBe(image);
      expect(wrapper.classList.contains("is-pending")).toBe(false);
      expect(wrapper.classList.contains("is-fallback")).toBe(false);
      agent.avatar = "/avatar/pending?v=2";
      update("renamed-surface");
      expect(wrapper.classList.contains("is-pending")).toBe(true);
      image.dispatchEvent(new Event("error"));
      update();
      expect(wrapper.classList.contains("is-pending")).toBe(false);
      expect(wrapper.classList.contains("is-fallback")).toBe(true);
      render(nothing, container);
    },
  );

  it("recognizes a cached image at mount without waiting for another load event", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(32);
    const container = document.createElement("div");
    render(renderAgentIdentityAvatar({ id: "cached", avatar: "/avatar/cached" }), container);
    await Promise.resolve();
    expect(
      container.querySelector(".identity-avatar--agent")?.classList.contains("is-pending"),
    ).toBe(false);
    expect(
      container.querySelector(".identity-avatar--agent")?.getAttribute("data-avatar-state"),
    ).toBe("loaded");
    render(nothing, container);
  });

  it("reveals the fallback when authenticated loading fails without an image event", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const response = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const container = document.createElement("div");
    render(renderAgentIdentityAvatar({ id: "failure", avatar: "/avatar/failure" }), container);
    const wrapper = container.querySelector(".identity-avatar--agent")!;
    expect(wrapper.classList.contains("is-pending")).toBe(true);
    response.resolve(new Response(null, { status: 404 }));
    await vi.waitFor(() => expect(wrapper.classList.contains("is-fallback")).toBe(true));
    expect(wrapper.classList.contains("is-pending")).toBe(false);
    expect(wrapper.getAttribute("data-avatar-state")).toBe("failed");
    render(nothing, container);
  });

  it.each(["openclaw", "crestodian"])(
    "keeps the product mark for system agent %s even with a configured avatar or image error",
    async (id) => {
      const container = document.createElement("div");
      const fetchAvatar = vi.spyOn(globalThis, "fetch");
      for (const avatar of [undefined, "/avatar/custom?v=1"]) {
        render(renderAgentIdentityAvatar({ id, avatar, textAvatar: "🔧" }), container);
        const image = container.querySelector("img");
        expect(image?.getAttribute("src")).toBe("/favicon.svg");
        image?.dispatchEvent(new Event("error"));
        await vi.dynamicImportSettled();
        expect(container.querySelector("svg, [data-avatar]")).toBeNull();
        expect(image?.getAttribute("src")).toBe("/favicon.svg");
      }
      expect(fetchAvatar).not.toHaveBeenCalled();
      render(nothing, container);
    },
  );

  it("uses the UI mount and build for the system mark when connected to another Gateway", () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    vi.stubGlobal("__OPENCLAW_CONTROL_UI_BASE_PATH__", "/control");
    document.documentElement.setAttribute("data-openclaw-control-ui-build-id", "build-1");
    const container = document.createElement("div");
    try {
      render(renderAgentIdentityAvatar({ id: "openclaw" }), container);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "/control/favicon.svg?v=build-1",
      );
    } finally {
      render(nothing, container);
      vi.unstubAllGlobals();
      document.documentElement.removeAttribute("data-openclaw-control-ui-build-id");
    }
  });

  it("prefers images, reveals emoji on failure, and recovers on image load", () => {
    const container = document.createElement("div");
    const agent = { id: "forge", avatar: "data:image/png;base64,eA==", textAvatar: "🔧" };
    const update = () => render(renderAgentIdentityAvatar(agent), container);
    update();
    const wrapper = container.querySelector(".identity-avatar--agent")!;
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(agent.avatar);
    expect(wrapper.classList.contains("is-fallback")).toBe(false);
    expect(container.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
      "🔧",
    );
    expect(container.querySelector("svg")).toBeNull();
    image.dispatchEvent(new Event("error"));
    update();
    expect(wrapper.classList.contains("is-fallback")).toBe(true);
    image.dispatchEvent(new Event("load"));
    expect(wrapper.classList.contains("is-fallback")).toBe(false);
    render(nothing, container);
  });

  it("uses explicit emoji before the same face used for a missing image", async () => {
    const container = document.createElement("div");
    render(renderAgentIdentityAvatar({ id: "forge", textAvatar: "🛠️" }), container);
    expect(
      container.querySelector(".identity-avatar--agent")?.getAttribute("data-avatar-state"),
    ).toBe("none");
    expect(container.querySelector("img, svg")).toBeNull();
    expect(container.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
      "🛠️",
    );
    render(renderAgentIdentityAvatar({ id: "forge" }), container);
    await vi.waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
    const face = container.querySelector("svg")!.outerHTML;
    render(renderAgentIdentityAvatar({ id: "forge", avatar: "/missing.png" }), container);
    container.querySelector("img")!.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(container.querySelector("svg")?.outerHTML).toBe(face));
    expect(
      container.querySelector(".identity-avatar--agent")?.classList.contains("is-fallback"),
    ).toBe(true);
    render(nothing, container);
  });
});

it("does not let pending face artwork replace a hydrated identity emoji", async () => {
  const container = document.createElement("div");
  render(renderAgentIdentityAvatar({ id: "hydrating" }), container);
  render(renderAgentIdentityAvatar({ id: "hydrating", textAvatar: "🦀" }), container);
  await vi.dynamicImportSettled();
  expect(container.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🦀");
  expect(container.querySelector("svg")).toBeNull();
  render(nothing, container);
});
