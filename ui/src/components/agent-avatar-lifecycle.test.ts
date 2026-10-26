/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { AgentIdentityResult } from "../api/types.ts";
import * as avatarGateway from "../lib/identity-avatar-context.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./agent-select-registration.ts";
import "./solid/agent-avatar.tsx";

const option = {
  value: "alpha",
  label: "Alpha",
  icon: "settings" as const,
  agent: { id: "alpha" },
};
const fixtures = [
  {
    name: "agent select",
    create(this: void) {
      const element = document.createElement("openclaw-agent-select");
      element.options = [option];
      element.value = option.value;
      return {
        element,
        setIdentity: (identity: AgentIdentityResult) => {
          element.identityById = { alpha: identity };
        },
      };
    },
  },
  {
    name: "agent avatar",
    create(this: void) {
      const element = document.createElement("openclaw-agent-avatar");
      element.option = option;
      return {
        element,
        setIdentity: (identity: AgentIdentityResult) => {
          element.identity = identity;
        },
      };
    },
  },
];

afterEach(async () => {
  document.body.replaceChildren();
  await waitForSolid(() => expect(document.querySelector(".agent-select__avatar")).toBeNull());
  setAvatarGatewayOrigin(null);
  vi.unstubAllGlobals();
});

it.each(fixtures)(
  "$name loads replacement and cached avatars across reconnect",
  async ({ create }) => {
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchAvatar = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    vi.stubGlobal("fetch", fetchAvatar);
    setAvatarGatewayOrigin(globalThis.location.origin);

    const { element, setIdentity } = create();
    setIdentity({ agentId: "alpha", name: "Alpha", avatar: "/avatar/alpha?rev=first" });
    document.body.append(element);
    await element.updateComplete;
    const image = () => element.querySelector<HTMLImageElement>(".agent-select__avatar img");
    await waitForSolid(() => expect(image()?.getAttribute("src")).toBe("blob:first"));
    expect(fetchAvatar).toHaveBeenCalledTimes(1);

    setIdentity({ agentId: "alpha", name: "Alpha", avatar: "/avatar/alpha?rev=second" });
    await element.updateComplete;
    await waitForSolid(() => expect(image()?.getAttribute("src")).toBe("blob:second"));
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
    const retiredImage = image()!;

    element.remove();
    await waitForSolid(() => expect(image()).toBeNull());
    document.body.append(element);
    await element.updateComplete;
    await waitForSolid(() => expect(image()?.getAttribute("src")).toBe("blob:second"));
    expect(image()).not.toBe(retiredImage);
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);

    retiredImage.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(image()?.getAttribute("src")).toBe("blob:second"));

    image()!.dispatchEvent(new Event("error"));
    await waitForSolid(() => {
      expect(image()).toBeNull();
      expect(element.querySelector(".agent-select__avatar--icon svg")).not.toBeNull();
    });
  },
);

it("shares one reset observer while preserving synchronous credential retirement", async () => {
  const createObjectURL = vi
    .fn()
    .mockReturnValueOnce("blob:old-context")
    .mockReturnValueOnce("blob:new-context");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const fetchAvatar = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
  vi.stubGlobal("fetch", fetchAvatar);
  setAvatarGatewayOrigin(globalThis.location.origin, ["old-test-token"]);

  // The permanent cache-retirement listener is already installed by module evaluation.
  const subscribe = avatarGateway.registerAvatarGatewayReset;
  let activeResetObservers = 0;
  const registrations = vi
    .spyOn(avatarGateway, "registerAvatarGatewayReset")
    .mockImplementation((listener) => {
      const stop = subscribe(listener);
      activeResetObservers += 1;
      return () => {
        activeResetObservers -= 1;
        stop();
      };
    });
  const mounted = fixtures.flatMap(({ create }) =>
    Array.from({ length: 4 }, () => {
      const fixture = create();
      fixture.setIdentity({ agentId: "alpha", avatar: "/avatar/alpha?rev=shared" });
      document.body.append(fixture.element);
      return fixture.element;
    }),
  );
  const images = () => mounted.flatMap((element) => [...element.querySelectorAll("img")]);
  // Each select renders its trigger and option avatar; standalone avatars render one each.
  const expectedImages = 12;
  try {
    await waitForSolid(() => {
      expect(images()).toHaveLength(expectedImages);
      expect(images().every((image) => image.getAttribute("src") === "blob:old-context")).toBe(
        true,
      );
      expect(activeResetObservers).toBe(1);
    });
    expect(fetchAvatar).toHaveBeenCalledTimes(1);
    const oldImages = images();
    setAvatarGatewayOrigin(globalThis.location.origin, ["new-test-token"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:old-context");
    oldImages.forEach((image) => image.dispatchEvent(new Event("error")));
    await waitForSolid(() => {
      expect(images()).toHaveLength(expectedImages);
      expect(images().every((image) => image.getAttribute("src") === "blob:new-context")).toBe(
        true,
      );
    });
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
    expect(activeResetObservers).toBe(1);
    expect(new Headers(fetchAvatar.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer old-test-token",
    );
    expect(new Headers(fetchAvatar.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer new-test-token",
    );

    mounted.slice(0, -1).forEach((element) => element.remove());
    await waitForSolid(() => expect(activeResetObservers).toBe(1));
    mounted.at(-1)!.remove();
    await waitForSolid(() => expect(activeResetObservers).toBe(0));
  } finally {
    mounted.forEach((element) => element.remove());
    await waitForSolid(() => expect(activeResetObservers).toBe(0));
    registrations.mockRestore();
  }
});
