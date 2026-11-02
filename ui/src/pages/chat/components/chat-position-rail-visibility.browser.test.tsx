import { expect, it, onTestFinished } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";

it("seeds the native observer's zero-area, edge-touching, and horizontal clipping answers", async () => {
  const cases = [
    { id: "inside", left: 20, top: 20, width: 20, height: 20, visible: true },
    { id: "zero-inside", left: 40, top: 40, width: 0, height: 0, visible: true },
    { id: "zero-edge", left: 1200, top: 40, width: 0, height: 0, visible: true },
    { id: "touch-edge", left: 20, top: 400, width: 20, height: 20, visible: false },
    { id: "clipped", left: 1201, top: 100, width: 20, height: 20, visible: false },
    { id: "partial", left: 1199, top: 150, width: 20, height: 20, visible: true },
  ];
  const session = new ChatSessionVirtualizerHost(() => {});
  const positions = {
    markers: cases.map(({ id }) => ({ id, anchorId: id, role: "user" as const, message: {} })),
    markerIdsByMessageId: new Map(cases.map(({ id }) => [id, id])),
  };
  const view = mountSolid(() => (
    <div
      class="chat-thread"
      data-position-rail-gutter
      style={{
        position: "relative",
        width: "1200px",
        height: "400px",
        padding: "0",
        "--chat-position-rail-viewport-height": "400px",
        "--chat-thread-padding-top": "0px",
        "--chat-thread-padding-bottom": "0px",
      }}
    >
      <div style={{ height: "1000px" }} />
      {cases.map((item) => (
        <div
          ref={session.messageElements.forKey(item.id)}
          data-entry-id={item.id}
          style={{
            position: "absolute",
            left: `${item.left}px`,
            top: `${item.top}px`,
            width: `${item.width}px`,
            height: `${item.height}px`,
          }}
        />
      ))}
      <ChatPositionRail positions={positions} transcript={session} />
    </div>
  ));
  onTestFinished(() => {
    view.unmount();
    session.dispose();
  });
  flush();
  await Promise.resolve();
  const commit = session.messageElements.prepareInitialLayout();
  expect(commit).toBeTypeOf("function");
  commit!();
  const seeded = [
    ...view.container.querySelectorAll<HTMLElement>("[data-position-marker-id][data-visible]"),
  ]
    .map((marker) => marker.dataset.positionMarkerId)
    .sort();
  const root = view.container.querySelector<HTMLElement>(".chat-thread")!;
  const observed = await new Promise<string[]>((resolve) => {
    const observer = new IntersectionObserver(
      (entries) => {
        observer.disconnect();
        resolve(
          entries
            .filter((entry) => entry.isIntersecting && entry.intersectionRatio > 0)
            .map((entry) => (entry.target as HTMLElement).dataset.entryId!)
            .sort(),
        );
      },
      { root, threshold: [0, Number.EPSILON, 1] },
    );
    for (const element of session.messageElements.elements.values()) observer.observe(element);
  });
  const expected = cases
    .filter((item) => item.visible)
    .map((item) => item.id)
    .sort();
  expect(observed).toEqual(expected);
  expect(seeded).toEqual(expected);
});
