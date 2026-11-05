import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatDetailsDesktopBody } from "./chat-details-desktop-body.tsx";

function mount(loading: boolean) {
  const container = document.body.appendChild(document.createElement("div"));
  function Body(props: { loading: boolean; height: number; presented: boolean }) {
    return (
      <ChatDetailsDesktopBody loading={props.loading} presented={props.presented}>
        <div style={{ height: props.height + "px" }}>Details content</div>
      </ChatDetailsDesktopBody>
    );
  }
  const view = mountSolid(
    Body,
    { loading, height: loading ? 210 : 90, presented: true },
    container,
  );
  onTestFinished(() => {
    view.dispose();
    container.remove();
  });
  return { ...view, body: container.querySelector<HTMLDivElement>(".chat-details-desktop-body")! };
}

function trackHandoffReads(body: HTMLDivElement) {
  const content = body.querySelector<HTMLDivElement>(".chat-details-desktop-body__content")!;
  const reads = [
    vi.spyOn(body, "getBoundingClientRect"),
    vi.spyOn(content, "getBoundingClientRect"),
    vi.spyOn(body, "offsetWidth", "get"),
    vi.spyOn(body, "clientWidth", "get"),
  ];
  onTestFinished(() => reads.forEach((read) => read.mockRestore()));
  return reads;
}

async function nextFrame() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  flush();
}

it("adds no handoff measurements or animations to cached and settled scrolling", async () => {
  const animations = vi.spyOn(Element.prototype, "animate");
  onTestFinished(() => animations.mockRestore());
  const view = mount(false);
  const reads = trackHandoffReads(view.body);
  await nextFrame();
  view.body.dispatchEvent(new Event("scroll"));
  await nextFrame();
  view.update({ loading: false, height: 150, presented: true });
  await nextFrame();
  view.body.dispatchEvent(new Event("focusin"));
  for (const read of reads) {
    expect(read).not.toHaveBeenCalled();
  }
  expect(animations.mock.contexts.filter((element) => element === view.body)).toHaveLength(0);
  expect(view.body.style.height).toBe("");
});

it("returns to natural height and the original scroll work after the cold handoff", async () => {
  const view = mount(true);
  await nextFrame();
  view.update({ loading: false, height: 90, presented: true });
  await expect.poll(() => view.body.getAnimations().length).toBe(1);
  await expect.poll(() => view.body.getAnimations().length).toBe(0);
  expect(view.body.style.height).toBe("");
  const reads = trackHandoffReads(view.body);
  view.body.dispatchEvent(new Event("scroll"));
  await nextFrame();
  for (const read of reads) {
    expect(read).not.toHaveBeenCalled();
  }
});
