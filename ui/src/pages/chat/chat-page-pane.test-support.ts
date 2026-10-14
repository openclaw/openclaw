import { spread } from "@solidjs/web";

/** Page tests observe bindings and retention without mounting the pane's domain owners. */
export function mockChatPagePane(props: Record<string, unknown>): HTMLElement {
  const host = document.createElement("openclaw-chat-pane");
  const bindings = Object.fromEntries(
    Object.keys(props).map((key) => [
      ["class", "inert", "children"].includes(key) ||
      key.startsWith("aria-") ||
      key.startsWith("data-")
        ? key
        : `prop:${key}`,
      { enumerable: true, get: () => props[key] },
    ]),
  );
  spread(host, Object.defineProperties({}, bindings), true);
  return host;
}
