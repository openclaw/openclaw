import { onSettled } from "solid-js";
import { defineSolidBridge } from "../lib/solid-bridge.ts";

if (typeof customElements !== "undefined" && !customElements.get("openclaw-math")) {
  defineSolidBridge(
    "openclaw-math",
    (props, host) => {
      let element: HTMLSpanElement | undefined;
      onSettled(() => {
        const update = async () => {
          try {
            const { renderMarkdownMath } = await import("./markdown-math-runtime.ts");
            // Read current source after loading; a streaming update may have replaced it.
            if (host.isConnected && element?.isConnected) {
              renderMarkdownMath(element, host.classList.contains("markdown-math-display"));
            }
          } catch (error) {
            console.warn("[markdown] Math rendering unavailable:", error);
          }
        };
        const observer = new MutationObserver(() => {
          void update();
        });
        observer.observe(element!, { childList: true, characterData: true, subtree: true });
        observer.observe(host, { attributes: true, attributeFilter: ["class"] });
        void update();
        return () => observer.disconnect();
      });
      return (
        <span
          ref={(node) => {
            element = node;
          }}
        >
          {props.children}
        </span>
      );
    },
    { properties: {} },
  );
}
