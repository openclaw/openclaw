/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { HtmlPreview } from "./chat-html-preview-view.tsx";
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
    const context = {
      gateway: {
        snapshot: { client: { request }, phase: "connected" },
        connection: { gatewayUrl: "ws://gateway.example:8443" },
        subscribe: () => () => {},
      },
    } as unknown as ApplicationContext;
    const provider = createSolidApplicationContextProvider(context);
    const [mode, setMode] = createSignal<"scripts" | "strict">("scripts");
    const view = mountSolid(
      () => (
        <HtmlPreview
          content="<h1>Preview</h1>"
          sourceIdentity="preview.html"
          title="Preview"
          embedSandboxMode={mode()}
        />
      ),
      {
        wrapper: provider.wrapper,
        container: document.body.appendChild(createApplicationContextProvider(context)),
      },
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

  it("aborts a replaced SVG read without allocating its late result", async () => {
    const requests: {
      signal: AbortSignal | null | undefined;
      resolve: (response: Response) => void;
    }[] = [];
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((resolve) => {
          requests.push({ signal: init?.signal, resolve });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:current-preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const [src, setSrc] = createSignal(`${window.location.origin}/previous.svg`);
    const view = mountSolid(() => <ChatSvgAttachment src={src()} label="preview.svg" />);
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledOnce());

    setSrc(`${window.location.origin}/current.svg`);
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(view.container.querySelector("img")).toBeNull();
    requests[0]?.resolve(new Response("<svg/>"));
    requests[1]?.resolve(new Response("<svg/>"));
    await waitForSolid(() =>
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:current-preview"),
    );
    expect(createUrl).toHaveBeenCalledOnce();
    view.unmount();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:current-preview");
  });
});
