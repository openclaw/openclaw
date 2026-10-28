/* @vitest-environment jsdom */
import { createComponent, flush } from "solid-js";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { setCurrentThemeBranding } from "../app/theme-branding.ts";
import { ChatAvatar, ForwardedAvatar } from "../pages/chat/chat-avatar-view.tsx";
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
const identity = (id = "agent-5", pending = false) =>
  createComponent(AgentIdentityAvatar, { agent: { id, pending, textAvatar: "🦀" } });
function mount(view: Parameters<typeof mountSolid>[0]) {
  const mounted = mountSolid(view, { container: document.createElement("div") });
  return { ...mounted, find: (selector: string) => mounted.container.querySelector(selector) };
}

it.each([
  ["identity", "agent-5", false, true],
  ["identity", "agent-0", false, false],
  ["identity", "agent-5", true, false],
  ["identity", "openclaw", false, false],
  ["identity", "crestodian", false, false],
  ["chat", "agent-5", false, true],
  ["chat", "agent-0", false, false],
  ["forwarded", "agent-5", false, true],
  ["forwarded", "agent-0", false, false],
] as const)("fedora on %s %s pending=%s: %s", (surface, id, pending, hat) => {
  setCurrentThemeBranding(branding);
  const avatar = "data:image/png;base64,YQ==";
  const { find, unmount } = mount(() =>
    surface === "identity"
      ? identity(id, pending)
      : surface === "chat"
        ? chat(id, avatar)
        : createComponent(ForwardedAvatar, {
            agentId: id,
            options: { agents: [{ id }], senderAgentAvatars: new Map([[id, avatar]]) },
          }),
  );
  const image = find("img");
  if (surface !== "identity") {
    expect(image).not.toBeNull();
    image!.dispatchEvent(new Event("load"));
    flush();
  }
  const overlay =
    surface === "identity"
      ? find(".identity-avatar__hat")
      : image?.parentElement?.querySelector(":scope > .identity-avatar__hat");
  expect(Boolean(overlay)).toBe(hat);
  if (hat) {
    expect(overlay?.classList.contains("identity-avatar__hat--fedora")).toBe(true);
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay?.querySelector(".identity-avatar__hat-svg")?.namespaceURI).toBe(
      "http://www.w3.org/2000/svg",
    );
  }
  resetBranding();
  flush();
  expect(find(".identity-avatar__hat")).toBeNull();
  unmount();
});
