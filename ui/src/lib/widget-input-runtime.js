// This import-free classic asset executes only in the opaque widget frame.
/** @typedef {import("./widget-input-document.ts").WidgetInputNode} WidgetInputNode */
(() => {
  const themeTokens = document.currentScript?.getAttribute("data-theme-tokens")?.split(" ") ?? [];
  const host = window.parent;
  const root = document.createElement("div");
  root.inert = true;
  document.body.append(root);
  /** @param {Node} parent @param {WidgetInputNode[]} next */
  const patch = (parent, next) => {
    for (const [index, value] of next.entries()) {
      let current = parent.childNodes[index];
      if (typeof value === "string") {
        if (current?.nodeType === Node.TEXT_NODE) {
          if (current.textContent !== value) {
            current.textContent = value;
          }
        } else {
          const text = document.createTextNode(value);
          if (current) {
            parent.replaceChild(text, current);
          } else {
            parent.appendChild(text);
          }
        }
        continue;
      }
      if (
        !(current instanceof Element) ||
        current.localName !== value.tag ||
        current.namespaceURI !== value.namespace
      ) {
        const element = document.createElementNS(value.namespace, value.tag);
        if (current) {
          parent.replaceChild(element, current);
        } else {
          parent.appendChild(element);
        }
        current = element;
      }
      if (!(current instanceof Element)) {
        continue;
      }
      const attributes = new Map(value.attributes);
      for (const attr of Array.from(current.attributes)) {
        if (!attributes.has(attr.name)) {
          current.removeAttribute(attr.name);
        }
      }
      for (const [name, attributeValue] of attributes) {
        if (current.getAttribute(name) !== attributeValue) {
          current.setAttribute(name, attributeValue);
        }
      }
      patch(current, value.children);
    }
    while (parent.childNodes.length > next.length) {
      parent.lastChild?.remove();
    }
  };
  let scheduled = false;
  const reportSize = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      // Empty script-generated containers and styles alone are not a preview.
      const hasContent =
        // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Sizing needs rendered text, excluding styles and hidden content.
        root.innerText.trim() ||
        Array.from(
          root.querySelectorAll(
            "svg path, svg rect, svg circle, svg ellipse, svg line, svg polyline, svg polygon, svg text",
          ),
        ).some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 || rect.height > 0;
        });
      host.postMessage(
        {
          type: "openclaw:widget-size",
          height: hasContent ? document.body.scrollHeight : 0,
        },
        "*",
      );
    });
  };
  new ResizeObserver(reportSize).observe(document.body);
  // This opaque document owns its sole handler for the document lifetime.
  // It cannot import the host UI listener primitive; generated scripts never run here.
  window.addEventListener("message", (event) => {
    if (event.source !== host) {
      return;
    }
    const data = event.data;
    if (data?.type === "openclaw:widget-input") {
      if (data.reset) {
        root.replaceChildren();
      }
      patch(root, data.nodes);
      reportSize();
    } else if (data?.type === "openclaw:widget-theme") {
      for (const key of themeTokens) {
        const value = data.tokens?.[key];
        if (typeof value === "string") {
          document.documentElement.style.setProperty(`--${key}`, value);
        }
      }
      document.documentElement.style.colorScheme = data.mode === "light" ? "light" : "dark";
    }
  });
  host.postMessage({ type: "openclaw:widget-input-ready" }, "*");
})();
