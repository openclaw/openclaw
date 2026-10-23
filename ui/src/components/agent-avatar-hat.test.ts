/* @vitest-environment jsdom */
import { createComponent, flush } from "solid-js";
import { afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { setCurrentThemeBranding } from "../app/theme-branding.ts";
import { ChatAvatar, ForwardedAvatar } from "../pages/chat/chat-avatar-view.tsx";
import * as artworkLoader from "../pages/plugins/icon-loader.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";

const pageLoadRandom = vi.hoisted(() => vi.spyOn(Math, "random").mockReturnValue(0));
beforeAll(() => pageLoadRandom.mockRestore());
const resetBranding = () =>
  setCurrentThemeBranding(resolveThemeBranding({ mascot: "claw", critters: [] }));
afterEach(() => {
  resetBranding();
  document.body.replaceChildren();
});

const branding = resolveThemeBranding({ mascot: "none", critters: [], avatarHat: "fedora" });
const chat = (agentId: string, avatar: string) =>
  createComponent(ChatAvatar, { role: "assistant", assistant: { agentId, name: "Scout", avatar } });
function mount(view: Parameters<typeof mountSolid>[0]) {
  const mounted = mountSolid(view, { container: document.createElement("div") });
  return { ...mounted, find: (selector: string) => mounted.container.querySelector(selector) };
}

it.each(["agent-5", "agent-0"])(
  "applies the theme hat to loaded transcript and forwarded photos for %s",
  (agentId) => {
    setCurrentThemeBranding(branding);
    const avatar = "data:image/png;base64,YQ==";
    for (const view of [
      () => chat(agentId, avatar),
      () =>
        createComponent(ForwardedAvatar, {
          agentId,
          options: {
            agents: [{ id: agentId }],
            senderAgentAvatars: new Map([[agentId, avatar]]),
          },
        }),
    ]) {
      const { find, unmount } = mount(view);
      const image = find("img")!;
      image.dispatchEvent(new Event("load"));
      flush();
      const hat = image.parentElement?.querySelector(":scope > .identity-avatar__hat");
      expect(Boolean(hat)).toBe(agentId === "agent-5");
      if (hat) {
        expect(hat.parentElement).toBe(image.parentElement);
        expect(hat.parentElement?.dataset.avatarState).toBe("loaded");
      }
      unmount();
    }
  },
);

it.each([
  ["agent-5", false, "none", true],
  ["agent-5", false, "claw", true],
  ["agent-0", false, "none", false],
  ["agent-5", true, "none", false],
  ["openclaw", false, "none", false],
  ["crestodian", false, "claw", false],
] as const)(
  "renders a fedora for %s (pending=%s, mascot=%s, hat=%s)",
  (id, pending, mascot, hat) => {
    setCurrentThemeBranding(resolveThemeBranding({ ...branding, mascot }));
    const { find, unmount } = mount(() =>
      createComponent(AgentIdentityAvatar, { agent: { id, pending, textAvatar: "🦀" } }),
    );
    const overlay = find(".identity-avatar--agent > .identity-avatar__hat");
    expect(Boolean(overlay)).toBe(hat);
    if (hat) {
      expect(overlay?.classList.contains("identity-avatar__hat--fedora")).toBe(true);
      expect(overlay?.getAttribute("aria-hidden")).toBe("true");
      expect(overlay?.querySelector(".identity-avatar__hat-svg")).toMatchObject({
        namespaceURI: "http://www.w3.org/2000/svg",
      });
    }
    resetBranding();
    flush();
    expect(find(".identity-avatar__hat")).toBeNull();
    unmount();
  },
);

it.each([false, true])(
  "renders a plugin hat on shared and chat photos (missing=%s)",
  async (missing) => {
    const fetchArtwork = vi
      .spyOn(artworkLoader, "fetchPluginThemeArtworkBlobUrl")
      .mockImplementation(async ({ url }) => (url.includes("missing") ? null : "blob:beret"));
    onTestFinished(() => fetchArtwork.mockRestore());
    setCurrentThemeBranding(
      resolveThemeBranding({
        mascot: "claw",
        critters: [],
        avatarHat: "beret",
        artwork: { hats: { beret: { url: missing ? "/missing" : "/beret" } } },
      }),
    );
    const mounted = mount(() =>
      createComponent(AgentIdentityAvatar, { agent: { id: "agent-5", textAvatar: "🦀" } }),
    );
    expect(mounted.find(".identity-avatar__hat-img")).toBeNull();
    await vi.dynamicImportSettled();
    expect(mounted.find(".identity-avatar__hat-img")?.getAttribute("src") ?? null).toBe(
      missing ? null : "blob:beret",
    );
    expect(mounted.find(".identity-avatar__hat svg")).toBeNull();
    mounted.unmount();
    const photo = mountSolid(() => chat("agent-5", "blob:photo"), { container: mounted.container });
    await vi.dynamicImportSettled();
    expect(
      mounted.find(".chat-avatar-slot > .identity-avatar__hat img")?.getAttribute("src") ?? null,
    ).toBe(missing ? null : "blob:beret");
    photo.unmount();
  },
);
