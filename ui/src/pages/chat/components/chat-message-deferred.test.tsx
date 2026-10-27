import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ToolPreview } from "./chat-message-deferred.tsx";

const moduleReady = vi.hoisted(() => Promise.withResolvers<void>());
// mock-isolation: Control lazy module readiness independently of the widget renderer and catalog setup.
vi.mock("./widget-card-view.tsx", async () => {
  await moduleReady.promise;
  return { ToolPreview: () => <span>Widget renderer ready</span> };
});

it("reserves declared and saved widget height before the lazy renderer arrives", async () => {
  let setSavedHeight!: (height: number | undefined) => void;
  const mounted = mountSolid(() => {
    const [savedHeight, setHeight] = createSignal<number>();
    setSavedHeight = setHeight;
    return (
      <ToolPreview
        preview={{
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          url: "/chart",
          preferredHeight: 220,
        }}
        surface="chat_message"
        options={{
          widgetLayout: {
            read: () => savedHeight(),
            write: () => undefined,
            writeRows: () => {},
            invalidateRow: () => {},
          },
        }}
      />
    );
  });
  try {
    flush();
    const placeholder = () =>
      mounted.container.querySelector<HTMLElement>(".chat-tool-card__preview");
    expect(placeholder()?.style.minHeight).toBe("220px");
    expect(mounted.container.textContent).not.toContain("Widget renderer ready");
    setSavedHeight(700);
    flush();
    expect(placeholder()?.style.minHeight).toBe("700px");
    moduleReady.resolve();
    await waitForSolid(() =>
      expect(mounted.container.textContent).toContain("Widget renderer ready"),
    );
    expect(placeholder()).toBeNull();
  } finally {
    moduleReady.resolve();
    mounted.unmount();
  }
});
