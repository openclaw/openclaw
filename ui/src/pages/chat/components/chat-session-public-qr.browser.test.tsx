import { afterEach, expect, it } from "vitest";
import { createMenuControls } from "../../../components/solid/menu.tsx";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSessionPublicQr } from "./chat-session-public-qr.tsx";

let mounted: ReturnType<typeof mountSolid<{ url: string }>> | undefined;
afterEach(() => {
  mounted?.dispose();
  mounted?.container.remove();
});

it("keeps the plain fallback, retires artwork on URL changes, and registers every menu control", async () => {
  const controls = createMenuControls();
  mounted = mountSolid(ChatSessionPublicQr, {
    url: "https://example.com/chat/openclaw/demo",
    controls,
  });
  document.body.append(mounted.container);
  const root = mounted.container;
  const toggle = root.querySelector("button")!;
  expect(root.querySelector(".qr-code")).not.toBeNull();
  expect(root.querySelector("img")).toBeNull();
  expect(controls.elements.has(toggle)).toBe(true);
  toggle.click();
  await waitForSolid(() =>
    expect(root.querySelector("img")?.getAttribute("src")).toMatch(/^data:/),
  );
  const image = root.querySelector("img")!;
  const download = root.querySelector<HTMLAnchorElement>("a[download]")!;
  expect(download.href).toBe(image.src);
  expect(controls.elements.has(download)).toBe(true);
  toggle.click();
  await waitForSolid(() => expect(root.querySelector(".qr-code")).not.toBeNull());
  expect(controls.elements.has(download)).toBe(false);
  toggle.click();
  await waitForSolid(() => expect(root.querySelector("img")).not.toBeNull());
  mounted.update({ url: "https://example.com/chat/openclaw/another-demo" });
  await waitForSolid(() => expect(root.querySelector("img")).toBeNull());
  expect(root.querySelector(".qr-code")).not.toBeNull();
});
