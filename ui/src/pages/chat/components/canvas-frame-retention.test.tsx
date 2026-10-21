/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context-types.ts";
import type { ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import { WIDGET_PROMPT_EVENT } from "../../../components/mcp-app-security.ts";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../../test-helpers/solid-application-context.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { SidebarPanel } from "./chat-sidebar-content.tsx";
import { ToolPreview } from "./widget-card.ts";

afterEach(() => vi.dynamicImportSettled());

it.each(["transcript", "strict transcript", "sidebar"] as const)(
  "retains the %s document through a blip and retires it on identity or access change",
  async (surface) => {
    // SAFETY: Raw frames only use the client as presentation identity; they issue no RPCs.
    const client = { request: vi.fn() } as unknown as ApplicationGatewaySnapshot["client"];
    const hello: ApplicationGatewaySnapshot["hello"] = {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"], recoveryScope: "reader-a" },
    };
    const fixture = createApplicationGateway();
    fixture.publish({
      ...fixture.gateway.snapshot,
      client,
      hello,
      phase: "connected",
      canvasPluginSurfaceUrl: "https://canvas.test/__openclaw__/cap/one",
      sessionKey: "agent:main:test",
    });
    // SAFETY: These leaf renderers consume only the Gateway capability.
    const provider = createSolidApplicationContextProvider({
      gateway: fixture.gateway,
    } as ApplicationContext);
    const entryUrl = "/__openclaw__/canvas/documents/cv_retained/index.html";
    const root = mountSolid(
      () => {
        const gateway = projectGateway(fixture.gateway);
        return surface !== "sidebar" ? (
          <ToolPreview
            preview={{
              kind: "canvas",
              surface: "assistant_message",
              render: "url",
              url: entryUrl,
              sandbox: surface === "strict transcript" ? "strict" : "scripts",
            }}
            surface="chat_message"
            options={{ canvasPluginSurfaceUrl: gateway.read().snapshot.canvasPluginSurfaceUrl }}
          />
        ) : (
          <SidebarPanel
            content={{ kind: "canvas", docId: "cv_retained", entryUrl }}
            showingRawText={false}
            error={null}
            onRetry={() => {}}
            onClose={() => {}}
            onViewRawText={() => {}}
            onClick={() => {}}
            onKeydown={() => {}}
            attachmentRuntime={{}}
            canvasPluginSurfaceUrl={gateway.read().snapshot.canvasPluginSurfaceUrl}
          />
        );
      },
      { wrapper: provider.wrapper },
    );
    const frame = () => root.container.querySelector<HTMLIFrameElement>("iframe");
    const original = frame()!;
    expect(original).not.toBeNull();
    const src = original.getAttribute("src");
    original.contentDocument!.open();
    original.contentDocument!.write('<input value="draft">');
    original.contentDocument!.close();
    const draft = original.contentDocument!.querySelector("input")!;
    draft.value = "unsaved work";
    original.dispatchEvent(new Event("load"));
    const prompts = vi.fn();
    root.container.addEventListener(WIDGET_PROMPT_EVENT, prompts);
    let expectPrompts: (count: number) => Promise<void> = async () => {};
    if (surface === "transcript") {
      const channel = new MessageChannel();
      onTestFinished(() => {
        channel.port1.close();
        channel.port2.close();
      });
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "openclaw:widget-prompt-offer" },
          origin: "null",
          source: original.contentWindow,
          ports: [channel.port2],
        }),
      );
      original.checkVisibility = () => true;
      original.focus();
      expectPrompts = async (count) => {
        await new Promise<void>((resolve) => {
          channel.port2.addEventListener("message", () => resolve(), { once: true });
          channel.port1.postMessage({ type: "openclaw:widget-prompt", prompt: "Keep working" });
        });
        expect(prompts).toHaveBeenCalledTimes(count);
      };
    }
    await expectPrompts(1);
    const publish = (patch: Partial<ApplicationGatewaySnapshot>) => {
      bumpCanvasWidgetFrameConnectionGeneration();
      fixture.publish({ ...fixture.gateway.snapshot, ...patch });
      flush();
    };
    publish({ phase: "reconnecting", hello: null, canvasPluginSurfaceUrl: null });
    expect(frame()).toBe(original);
    expect(original.getAttribute("src")).toBe(src);
    await expectPrompts(1);
    publish({
      phase: "connected",
      hello,
      canvasPluginSurfaceUrl: "https://canvas.test/__openclaw__/cap/two",
    });
    expect(frame()).toBe(original);
    expect(original.getAttribute("src")).toBe(src);
    expect(original.contentDocument!.querySelector("input")).toBe(draft);
    expect(draft.value).toBe("unsaved work");
    await expectPrompts(2);

    publish({ client: { request: vi.fn() } as unknown as ApplicationGatewaySnapshot["client"] });
    expect(frame()).not.toBe(original);
    publish({ hello: { ...hello, auth: { role: "operator", scopes: [] } } });
    expect(frame()).toBeNull();
  },
);
