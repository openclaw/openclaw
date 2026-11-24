import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSessionPublicQr } from "./chat-session-public-qr.tsx";

const url = "https://example.com/chat/openclaw/demo";
let mounted: ReturnType<typeof mountSolid<{ url: string }>> | undefined;
afterEach(() => {
  mounted?.dispose();
  mounted?.container.remove();
  vi.restoreAllMocks();
});

function mountQr(width: number) {
  mounted = mountSolid(ChatSessionPublicQr, { url });
  mounted.container.style.width = width + "px";
  document.body.append(mounted.container);
  return mounted;
}

it("shows the claw by default and switches to a plain symbol when the panel narrows", async () => {
  const qr = mountQr(300);
  const { container } = qr;
  const source = () => container.querySelector("img")?.getAttribute("src");
  await waitForSolid(() => expect(source()).toMatch(/^data:image\/png/));
  const original = source();
  qr.update({ url: url + "/new" });
  await waitForSolid(() => {
    expect(source()).toMatch(/^data:image\/png/);
    expect(source()).not.toBe(original);
  });
  container.style.width = "224px";
  await waitForSolid(() => {
    expect(source()).toBeUndefined();
    expect(container.querySelector("svg.qr-code")?.getBoundingClientRect().width).toBe(200);
  });
  container.style.width = "300px";
  await waitForSolid(() => expect(source()).toMatch(/^data:image\/png/));
});

it("keeps a plain code when artwork fails, without asking the user to switch", async () => {
  const decode = vi
    .spyOn(HTMLImageElement.prototype, "decode")
    .mockRejectedValue(new Error("Image unavailable"));
  const { container } = mountQr(300);
  await waitForSolid(() => expect(decode).toHaveBeenCalledOnce());
  expect(container.querySelector("svg.qr-code")).not.toBeNull();
  expect(container.querySelector("img, button, a[download]")).toBeNull();
});
