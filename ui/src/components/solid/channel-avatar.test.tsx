import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { ChannelAvatarContent } from "./channel-avatar.tsx";

it("keeps its fallback mounted through loading, a decoded image, and an image error", async () => {
  vi.useFakeTimers();
  const response = createDeferred<Response>();
  vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:channel-face");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const view = mountSolid(() => (
    <ChannelAvatarContent routeUrl="/channel-avatar/room" authReady={true}>
      <button>Room</button>
    </ChannelAvatarContent>
  ));
  const fallback = view.getByRole("button", { name: "Room" });
  try {
    expect(view.container.querySelector("img")).toBeNull();
    response.resolve(new Response(new Blob(["face"], { type: "image/png" })));
    await vi.advanceTimersByTimeAsync(0);
    flush();
    const image = view.container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("blob:channel-face");
    expect(fallback.parentElement?.style.display).toBe("none");
    image.dispatchEvent(new Event("error"));
    flush();
    expect(view.getByRole("button", { name: "Room" })).toBe(fallback);
    expect(fallback.parentElement?.style.display).toBe("contents");
    expect(view.container.querySelector("img")).toBeNull();
  } finally {
    view.unmount();
    await vi.runOnlyPendingTimersAsync();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
  expect(revoke).toHaveBeenCalledWith("blob:channel-face");
});
