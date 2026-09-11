import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTerminalImeWorkaround } from "./terminal-runtime.ts";

/**
 * Creates a ghostty-like container in the real DOM: a div holding both a
 * canvas and a textarea (the structure ghostty-web creates inside its
 * container). The caller provides the container element, so tests can
 * pre-install the ghostty beforeinput bug simulation before calling
 * installTerminalImeWorkaround.
 */
function createGhosttyContainer(): {
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textarea: HTMLTextAreaElement;
} {
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  const textarea = document.createElement("textarea");
  container.appendChild(canvas);
  container.appendChild(textarea);
  document.body.appendChild(container);
  return { container, canvas, textarea };
}

/**
 * Installs the ghostty beforeinput bug simulation: it calls e.preventDefault()
 * on all beforeinput events on the container, exactly as ghostty-web 0.4.0 does.
 * Must be called before installTerminalImeWorkaround so the probe sees the bug.
 */
function installGhosttyBugSimulation(container: HTMLElement): void {
  container.addEventListener("beforeinput", (e) => e.preventDefault());
}

/**
 * jsdom has no complete InputEvent API, but the InputEvent constructor does
 * exist. Dispatching through the real tree keeps composedPath() authentic,
 * which is the part of findGhosttyContainer under test.
 *
 * For beforeinput, we dispatch on a descendant element so the event bubbles
 * through the container, which is how Android IME actually delivers it.
 */
function dispatchBeforeInput(target: Element, inputType: string, data: string | null = null): void {
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    composed: true,
    cancelable: true,
    inputType,
    data: data ?? undefined,
  });
  target.dispatchEvent(event);
}

/**
 * Activates IME state via keydown with keyCode 229 dispatched on the target,
 * mirroring what Android Chrome sends when an IME session starts.
 */
function dispatchImeKeyDown(target: Element): void {
  // jsdom does not support keyCode via the KeyboardEvent constructor, so attach
  // it directly on a plain Event, the same pattern used in nav-drawer tests.
  const event = new Event("keydown", { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "keyCode", { value: 229 });
  Object.defineProperty(event, "isComposing", { value: true });
  target.dispatchEvent(event);
}

describe("installTerminalImeWorkaround", () => {
  let cleanupWorkaround: (() => void) | undefined;

  beforeEach(() => {
    cleanupWorkaround = undefined;
  });

  afterEach(() => {
    cleanupWorkaround?.();
    cleanupWorkaround = undefined;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    // jsdom keeps navigator properties across tests; reset manually.
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 0,
      configurable: true,
      writable: true,
    });
  });

  function setupCoarseDevice(): void {
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 5,
      configurable: true,
      writable: true,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
  }

  function setupNonTouchDevice(): void {
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 0,
      configurable: true,
      writable: true,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList),
    );
  }

  it("on coarse-pointer device: beforeinput insertText during IME active dispatches compositionend on ghostty container", () => {
    setupCoarseDevice();
    const { container, textarea } = createGhosttyContainer();
    // Simulate the ghostty bug before installing the workaround so the probe
    // at install time correctly detects it.
    installGhosttyBugSimulation(container);

    const received: CompositionEvent[] = [];
    container.addEventListener("compositionend", (e) => received.push(e as CompositionEvent));

    cleanupWorkaround = installTerminalImeWorkaround(container);

    // Activate IME state, then commit text.
    dispatchImeKeyDown(textarea);
    dispatchBeforeInput(textarea, "insertText", "あ");

    expect(received).toHaveLength(1);
    expect(received[0]?.data).toBe("あ");
  });

  it("on coarse-pointer device: beforeinput during non-IME state does nothing", () => {
    setupCoarseDevice();
    const { container, textarea } = createGhosttyContainer();
    installGhosttyBugSimulation(container);

    const received: CompositionEvent[] = [];
    container.addEventListener("compositionend", (e) => received.push(e as CompositionEvent));

    cleanupWorkaround = installTerminalImeWorkaround(container);

    // No IME keydown -- fire a plain insertText that should not be forwarded.
    dispatchBeforeInput(textarea, "insertText", "a");

    expect(received).toHaveLength(0);
  });

  it("on non-touch device: fix is not installed (no compositionend dispatched)", () => {
    setupNonTouchDevice();
    const { container, textarea } = createGhosttyContainer();
    installGhosttyBugSimulation(container);

    const received: CompositionEvent[] = [];
    container.addEventListener("compositionend", (e) => received.push(e as CompositionEvent));

    cleanupWorkaround = installTerminalImeWorkaround(container);

    dispatchImeKeyDown(textarea);
    dispatchBeforeInput(textarea, "insertText", "あ");

    expect(received).toHaveLength(0);
  });

  it("insertLineBreak maps to carriage return", () => {
    setupCoarseDevice();
    const { container, textarea } = createGhosttyContainer();
    installGhosttyBugSimulation(container);

    const received: CompositionEvent[] = [];
    container.addEventListener("compositionend", (e) => received.push(e as CompositionEvent));

    cleanupWorkaround = installTerminalImeWorkaround(container);

    dispatchImeKeyDown(textarea);
    dispatchBeforeInput(textarea, "insertLineBreak");

    expect(received).toHaveLength(1);
    expect(received[0]?.data).toBe("\r");
  });

  it("insertParagraph also maps to carriage return", () => {
    setupCoarseDevice();
    const { container, textarea } = createGhosttyContainer();
    installGhosttyBugSimulation(container);

    const received: CompositionEvent[] = [];
    container.addEventListener("compositionend", (e) => received.push(e as CompositionEvent));

    cleanupWorkaround = installTerminalImeWorkaround(container);

    dispatchImeKeyDown(textarea);
    dispatchBeforeInput(textarea, "insertParagraph");

    expect(received).toHaveLength(1);
    expect(received[0]?.data).toBe("\r");
  });

  it("deleteContentBackward maps to DEL byte (0x7f)", () => {
    setupCoarseDevice();
    const { container, textarea } = createGhosttyContainer();
    installGhosttyBugSimulation(container);

    const received: CompositionEvent[] = [];
    container.addEventListener("compositionend", (e) => received.push(e as CompositionEvent));

    cleanupWorkaround = installTerminalImeWorkaround(container);

    dispatchImeKeyDown(textarea);
    dispatchBeforeInput(textarea, "deleteContentBackward");

    expect(received).toHaveLength(1);
    expect(received[0]?.data).toBe("\x7f");
  });

  it("cleanup removes listeners so subsequent beforeinput no longer forwards", () => {
    setupCoarseDevice();
    const { container, textarea } = createGhosttyContainer();
    installGhosttyBugSimulation(container);

    const received: CompositionEvent[] = [];
    container.addEventListener("compositionend", (e) => received.push(e as CompositionEvent));

    const cleanup = installTerminalImeWorkaround(container);
    cleanup();
    // cleanupWorkaround already cleared to avoid double-cleanup in afterEach.

    dispatchImeKeyDown(textarea);
    dispatchBeforeInput(textarea, "insertText", "あ");

    expect(received).toHaveLength(0);
  });
});
