/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

afterEach(async () => {
  await vi.dynamicImportSettled();
});

describe("raw Canvas frame retention", () => {
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
      const initial: ApplicationGatewaySnapshot = {
        client,
        hello,
        phase: "connected",
        offlineStable: false,
        canvasPluginSurfaceUrl: "https://canvas.test/__openclaw__/cap/one",
        assistantAgentId: null,
        sessionKey: "agent:main:test",
        lastError: null,
        lastErrorCode: null,
      };
      const fixture = createApplicationGateway(initial);
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
      const original = root.container.querySelector<HTMLIFrameElement>("iframe")!;
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
      let sendPrompt: (() => Promise<void>) | undefined;
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
        sendPrompt = () =>
          new Promise((resolve) => {
            channel.port2.addEventListener("message", () => resolve(), { once: true });
            channel.port1.postMessage({ type: "openclaw:widget-prompt", prompt: "Keep working" });
          });
        await sendPrompt();
        expect(prompts).toHaveBeenCalledTimes(1);
      }
      const publish = (patch: Partial<ApplicationGatewaySnapshot>) => {
        bumpCanvasWidgetFrameConnectionGeneration();
        fixture.publish({ ...fixture.gateway.snapshot, ...patch });
        flush();
      };
      publish({ phase: "reconnecting", hello: null, canvasPluginSurfaceUrl: null });
      expect(root.container.querySelector("iframe")).toBe(original);
      expect(original.getAttribute("src")).toBe(src);
      await sendPrompt?.();
      if (sendPrompt) {
        expect(prompts).toHaveBeenCalledTimes(1);
      }
      publish({
        phase: "connected",
        hello,
        canvasPluginSurfaceUrl: "https://canvas.test/__openclaw__/cap/two",
      });
      expect(root.container.querySelector("iframe")).toBe(original);
      expect(original.getAttribute("src")).toBe(src);
      expect(original.contentDocument!.querySelector("input")).toBe(draft);
      expect(draft.value).toBe("unsaved work");
      await sendPrompt?.();
      if (sendPrompt) {
        expect(prompts).toHaveBeenCalledTimes(2);
      }

      // SAFETY: Replacing the same minimal client fixture exercises identity retirement.
      publish({ client: { request: vi.fn() } as unknown as ApplicationGatewaySnapshot["client"] });
      expect(root.container.querySelector("iframe")).not.toBe(original);
      publish({ hello: { ...hello, auth: { role: "operator", scopes: [] } } });
      expect(root.container.querySelector("iframe")).toBeNull();
    },
  );
});
