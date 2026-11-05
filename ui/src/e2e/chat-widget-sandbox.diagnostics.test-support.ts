import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

/** Synthetic documents and mocked Gateway only; never record content or URLs. */
export async function installWidgetPromptDiagnostics(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const events: unknown[] = [];
    Object.defineProperty(window, "openclawSyntheticWidgetTimeline", { value: events });
    const element = (value: EventTarget | null) =>
      value instanceof Element ? { tag: value.tagName, id: value.id.slice(0, 32) } : null;
    const record = (kind: string, detail: Record<string, unknown> = {}) => {
      const frame = document.querySelector(".chat-tool-card__preview-frame");
      const rect = frame?.getBoundingClientRect();
      if (events.length === 256) {
        events.shift();
      }
      events.push({
        at: performance.timeOrigin + performance.now(),
        kind,
        active: element(document.activeElement),
        activation: navigator.userActivation.isActive,
        frameFocused: frame ? document.activeElement === frame : null,
        frameConnected: frame?.isConnected ?? null,
        frameVisible: frame?.checkVisibility() ?? null,
        frameRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        ...detail,
      });
    };
    const recordInput = (event: Event) =>
      record(event.type, {
        trusted: event.isTrusted,
        target: element(event.target),
        ...(event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : {}),
      });
    for (const kind of ["pointerdown", "pointerup", "click", "focusin", "focusout"]) {
      document.addEventListener(kind, recordInput, true);
    }
    window.addEventListener("message", (event) => {
      const type = event.data?.type;
      const allowed = ["size", "prompt-offer", "bridge-ready"];
      if (!allowed.some((kind) => type === `openclaw:widget-${kind}`)) {
        return;
      }
      record(type, {
        ports: event.ports.length,
        ...(type === "openclaw:widget-size" && Number.isFinite(event.data.height)
          ? { height: Math.min(10000, Math.max(0, event.data.height)) }
          : {}),
      });
      if (type === "openclaw:widget-prompt-offer") {
        // Observe the transferred port without starting it or changing its owner.
        for (const port of event.ports) {
          port.addEventListener(
            "message",
            (message) =>
              message.data?.type === "openclaw:widget-prompt" && record("prompt-received"),
          );
        }
      }
    });
    document.addEventListener("openclaw-widget-prompt", () => record("prompt-dispatched"), true);
  });
}

export async function retainWidgetPromptFailure(page: Page, artifactDir: string): Promise<void> {
  const frames = [];
  for (const [index, frame] of page.frames().slice(0, 8).entries()) {
    try {
      const events = await frame.evaluate(
        () =>
          (window as Window & { openclawSyntheticWidgetTimeline?: unknown[] })
            .openclawSyntheticWidgetTimeline ?? [],
      );
      frames.push({ index, events });
    } catch {
      frames.push({ index, unavailable: true });
    }
  }
  const report = { fixture: "chat-widget-sandbox", synthetic: true, version: 1, frames };
  const file = path.join(artifactDir, "widget-prompt-failure.json");
  await writeFile(file, JSON.stringify(report, null, 2));
}
