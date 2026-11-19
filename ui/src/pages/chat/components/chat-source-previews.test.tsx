/* @vitest-environment jsdom */

import { setWriteHook } from "@solidjs/signals";
import { createRoot, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSourcePreviews } from "./chat-source-previews.tsx";

const source = (host: string) => ({ url: `https://${host}/page`, title: host, domain: host });
it("does not request favicons after disposal before the first settlement", () => {
  const fetchFavicon = vi.fn(async () => null);
  createRoot((dispose) => {
    const content = (
      <ChatSourcePreviews fetchFavicon={fetchFavicon} sources={[source("retired.test")]} />
    );
    dispose();
    return content;
  });
  flush();
  expect(fetchFavicon).not.toHaveBeenCalled();
});

it("requests a favicon once after settlement and ignores its result after disposal", async () => {
  const pending = Promise.withResolvers<string | null>();
  const fetchFavicon = vi.fn(() => pending.promise);
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const view = mountSolid(() => (
    <ChatSourcePreviews sources={[source("held.test")]} fetchFavicon={fetchFavicon} />
  ));
  await waitForSolid(() => expect(fetchFavicon).toHaveBeenCalledOnce());
  expect(view.container.querySelector("img")).toBeNull();
  view.unmount();
  const writes = vi.fn();
  onTestFinished(() => {
    setWriteHook(null);
    revoke.mockRestore();
  });
  setWriteHook(writes);
  pending.resolve("blob:retired-source-favicon");
  await pending.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(writes).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledWith("blob:retired-source-favicon");
});

it("opens the matching source dialog and retires it when that source leaves", () => {
  const [sources, setSources] = createSignal([source("example.test")]);
  const { container } = mountSolid(() => <ChatSourcePreviews sources={sources()} />);
  flush();
  const trigger = container.querySelector<HTMLButtonElement>(".chat-source-card")!;
  trigger.click();
  const surface = container.querySelector<HTMLElement>(".chat-source-popover")!;
  expect(surface.matches(":popover-open")).toBe(true);
  setSources([]);
  flush();
  expect(container.querySelector(".chat-source-card")).toBeNull();
  expect(surface.matches(":popover-open")).toBe(false);
});
