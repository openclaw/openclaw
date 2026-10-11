/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatHtmlPreview } from "./chat-html-preview-element.tsx";
import { ChatSvgAttachment } from "./chat-svg-attachment.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Solid preview consumers", () => {
  it("loads the HTML frame when mounted from a Solid parent", async () => {
    const request = vi.fn().mockResolvedValue({
      html: "<h1>Preview</h1>",
      sandboxUrl: "/mcp-app-sandbox?frames=none",
      sandboxPort: 8444,
    });
    const provider = createSolidApplicationContextProvider({
      gateway: {
        snapshot: { client: { request }, phase: "connected" },
        connection: { gatewayUrl: "ws://gateway.example:8443" },
        subscribe: () => () => {},
      },
    } as unknown as ApplicationContext);
    const [mode, setMode] = createSignal<"scripts" | "strict">("scripts");
    const view = mountSolid(
      () => (
        <ChatHtmlPreview
          html="<h1>Preview</h1>"
          sourceIdentity="preview.html"
          embedSandboxMode={mode()}
        />
      ),
      { wrapper: provider.wrapper },
    );
    await waitForSolid(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe");
    setMode("strict");
    await waitForSolid(() => {
      expect(view.container.querySelector("iframe")).not.toBeNull();
      expect(view.container.querySelector("iframe")).not.toBe(frame);
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("loads an SVG image when mounted from a Solid parent", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetchMock = vi.fn(
      async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:solid-preview")
      .mockReturnValueOnce("blob:next-preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const [src, setSrc] = createSignal(`${window.location.origin}/preview.svg`);
    const view = mountSolid(() => <ChatSvgAttachment src={src()} label="preview.svg" />);
    await waitForSolid(() =>
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:solid-preview"),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    setSrc(`${window.location.origin}/next.svg`);
    await waitForSolid(() =>
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:next-preview"),
    );
    expect(revoke).toHaveBeenCalledWith("blob:solid-preview");
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:next-preview");
  });
});
