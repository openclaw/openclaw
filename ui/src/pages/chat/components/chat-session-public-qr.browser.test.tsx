import { afterEach, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSessionPublicQr } from "./chat-session-public-qr.tsx";

let mounted: ReturnType<typeof mountSolid<{ url: string }>> | undefined;
afterEach(() => {
  mounted?.dispose();
  mounted?.container.remove();
});

it("opens on demand, offers a plain-code fallback, and updates the encoded URL", async () => {
  mounted = mountSolid(ChatSessionPublicQr, { url: "https://example.com/chat/openclaw/demo" });
  document.body.append(mounted.container);
  const container = mounted.container;
  expect(container.querySelector("img")).toBeNull();
  container.querySelector("summary")!.click();
  await waitForSolid(() =>
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/^data:/),
  );
  const image = container.querySelector("img")!;
  expect(image.alt).toBe("QR code for this public session link");
  const halftone = image.src;
  const download = container.querySelector<HTMLAnchorElement>("a[download]")!;
  expect(download.href).toBe(halftone);
  expect(download.download).toBe("openclaw-public-link-qr.png");
  const toggle = container.querySelector("button")!;
  toggle.click();
  await waitForSolid(() => expect(toggle.textContent).toBe("Use OpenClaw QR"));
  expect(image.src).not.toBe(halftone);
  expect(download.href).toBe(image.src);
  toggle.click();
  await waitForSolid(() => expect(image.src).toBe(halftone));
  mounted.update({ url: "https://example.com/chat/openclaw/another-demo" });
  await waitForSolid(() => {
    const next = container.querySelector("img")?.getAttribute("src");
    expect(next).toMatch(/^data:/);
    expect(next).not.toBe(halftone);
  });
  container.querySelector("summary")!.click();
  await waitForSolid(() => expect(container.querySelector("img")).toBeNull());
});
