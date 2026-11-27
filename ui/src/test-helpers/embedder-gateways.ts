import { vi } from "vitest";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";

export const embedderSnapshot: NativeGatewaysSnapshot = {
  gateways: [
    {
      id: "personal",
      name: "My Claw",
      kind: "remote",
      isPrimary: true,
      canPromote: false,
      health: "ok",
    },
    {
      id: "team",
      name: "Team",
      kind: "remote",
      isPrimary: false,
      canPromote: true,
      health: "unknown",
    },
  ],
  currentId: "team",
};

export function installEmbedderGatewayTestBridge() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const parent = frame.contentWindow!;
  vi.stubGlobal("parent", parent);
  document.documentElement.setAttribute("data-openclaw-remote-ingress", "true");
  const postMessage = vi.spyOn(parent, "postMessage").mockImplementation(() => {});
  return {
    parent,
    postMessage,
    publish(snapshot: unknown = embedderSnapshot) {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: parent,
          origin: "https://embedder.example",
          data: { type: "openclaw.embedder.gateways", version: 1, snapshot },
        }),
      );
    },
    dispose() {
      frame.remove();
      document.documentElement.removeAttribute("data-openclaw-remote-ingress");
      Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAYS__");
      vi.unstubAllGlobals();
    },
  };
}
