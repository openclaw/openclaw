import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatDetailsDesktopBody, type ChatDetailsHandoff } from "./chat-details-desktop-body.tsx";

function mount(loading: boolean) {
  const container = document.body.appendChild(document.createElement("div"));
  let handoff!: ChatDetailsHandoff;
  function Body(props: { height: number; presented: boolean }) {
    return (
      <ChatDetailsDesktopBody presented={props.presented}>
        {(lifecycle) => {
          handoff = lifecycle;
          return <div style={{ height: props.height + "px" }}>Details content</div>;
        }}
      </ChatDetailsDesktopBody>
    );
  }
  const view = mountSolid(Body, { height: loading ? 210 : 90, presented: true }, container);
  if (loading) {
    handoff.onLoading(true);
  }
  onTestFinished(() => {
    view.dispose();
    container.remove();
  });
  return {
    ...view,
    ...handoff,
    body: container.querySelector<HTMLDivElement>(".chat-details-desktop-body")!,
  };
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
  view.onReady();
  await nextFrame();
  view.body.dispatchEvent(new Event("scroll"));
  await nextFrame();
  view.update({ height: 150, presented: true });
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
  view.update({ height: 90, presented: true });
  view.onLoading(false);
  view.onReady();
  await expect.poll(() => view.body.getAnimations().length).toBe(1);
  await expect.poll(() => view.body.getAnimations().length).toBe(0);
  expect(view.body.style.height).toBe("");
  const reads = trackHandoffReads(view.body);
  view.body.dispatchEvent(new Event("scroll"));
  await nextFrame();
  for (const read of reads) {
    expect(read).not.toHaveBeenCalled();
  }
  view.update({ height: 210, presented: true });
  view.onLoading(true);
  view.update({ height: 90, presented: true });
  view.onLoading(false);
  view.onReady();
  expect(view.body.getAnimations()).toHaveLength(1);
  view.body.parentElement!.remove();
  view.update({ height: 90, presented: false });
  expect(view.body.getAnimations()).toHaveLength(0);
  expect(view.body.style.height).toBe("");
});
