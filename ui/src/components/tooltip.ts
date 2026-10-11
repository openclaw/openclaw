import type { TemplateResult } from "lit";
import { isTooltipTriggerElement } from "./tooltip-content.ts";
import {
  TooltipController,
  consumeTooltipEscape,
  type TooltipPolicyProps,
} from "./tooltip-controller.ts";

export { consumeTooltipEscape };

export interface TooltipProps extends TooltipPolicyProps {
  contentTemplate?: TemplateResult;
}
export interface TooltipRuntime {
  request(open: boolean): boolean;
  update(): void;
  retire(): void;
  dispose(): void;
}

const SKIP_DELAY = 300;

export class TooltipProvider extends HTMLElement {
  delayed = true;
  #focusInput: "keyboard" | "pointer" = "keyboard";
  #skipDelayTimer: number | null = null;

  connectedCallback() {
    this.style.display = "contents";
    this.#focusInput = "keyboard";
    // Pointer focus can arrive after an action re-renders. Keep modality at
    // the provider so delayed focus cannot reopen the action's tooltip.
    this.ownerDocument.addEventListener("keydown", this.#handleDocumentKeyDown, true);
    this.ownerDocument.addEventListener("pointerdown", this.#handleDocumentPointerDown, true);
  }

  disconnectedCallback() {
    this.ownerDocument.removeEventListener("keydown", this.#handleDocumentKeyDown, true);
    this.ownerDocument.removeEventListener("pointerdown", this.#handleDocumentPointerDown, true);
    TooltipController.closeForProvider(this);
    this.#clearSkipDelayTimer();
    this.delayed = true;
  }

  focusOpensTooltip() {
    return this.#focusInput === "keyboard";
  }

  openTooltip() {
    this.delayed = false;
    this.#clearSkipDelayTimer();
  }

  closeTooltip() {
    this.#clearSkipDelayTimer();
    this.#skipDelayTimer = window.setTimeout(() => {
      this.#skipDelayTimer = null;
      this.delayed = true;
    }, SKIP_DELAY);
  }

  #clearSkipDelayTimer() {
    if (this.#skipDelayTimer !== null) {
      window.clearTimeout(this.#skipDelayTimer);
      this.#skipDelayTimer = null;
    }
  }

  readonly #handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (!["Alt", "Control", "Meta", "Shift"].includes(event.key)) {
      this.#focusInput = "keyboard";
    }
  };

  readonly #handleDocumentPointerDown = () => {
    this.#focusInput = "pointer";
  };
}

const defaults = {
  content: "",
  contentTemplate: undefined,
  placement: "top",
  closeDelay: 100,
  hoverDismissDelay: undefined,
  delay: undefined,
  describe: true,
  autoSize: false,
  disabled: false,
  openOnClick: false,
  anchor: null,
};
const attributes = new Map([
  ["content", "content"],
  ["placement", "placement"],
  ["closedelay", "closeDelay"],
  ["hoverdismissdelay", "hoverDismissDelay"],
  ["delay", "delay"],
  ["describe", "describe"],
  ["auto-size", "autoSize"],
  ["disabled", "disabled"],
  ["open-on-click", "openOnClick"],
]);
type MountTooltipView = typeof import("./solid/tooltip.tsx").mountTooltipView;
let mountTooltipView: MountTooltipView | undefined;
let viewImport: Promise<MountTooltipView> | undefined;

/** Policy and descriptions are eager; presentation loads only for actual reveal intent. */
export class TooltipElement extends HTMLElement implements TooltipProps {
  static observedAttributes = [...attributes.keys()];
  declare content: string;
  declare contentTemplate: TemplateResult | undefined;
  declare placement: TooltipPolicyProps["placement"];
  declare closeDelay: number;
  declare hoverDismissDelay: number | undefined;
  declare delay: number | undefined;
  declare describe: boolean;
  declare autoSize: boolean;
  declare disabled: boolean;
  declare openOnClick: boolean;
  declare anchor: HTMLElement | SVGElement | null;

  readonly #values = new Map<string, unknown>(Object.entries(defaults));
  readonly #triggerSlot: HTMLSlotElement;
  readonly #contentSlot: HTMLSlotElement;
  readonly #surface: HTMLDivElement;
  readonly #rich: HTMLSpanElement;
  readonly #controller: TooltipController;
  readonly #children: MutationObserver;
  #runtime: TooltipRuntime | undefined;
  #pendingUpdate: Promise<boolean> | undefined;
  #loading: Promise<boolean> | undefined;
  #wanted = false;

  constructor() {
    super();
    for (const [key, value] of Object.entries(defaults)) {
      const initial = Object.hasOwn(this, key) ? Reflect.get(this, key) : value;
      this.#values.set(key, initial);
      Object.defineProperty(this, key, {
        configurable: true,
        get: () => this.#values.get(key),
        set: (next: unknown) => {
          if (!Object.is(this.#values.get(key), next)) {
            this.#values.set(key, next);
            this.#scheduleUpdate();
          }
        },
      });
    }
    const root = this.attachShadow({ mode: "open" });
    this.#triggerSlot = this.ownerDocument.createElement("slot");
    this.#surface = this.ownerDocument.createElement("div");
    this.#surface.className = "oc-overlay tooltip-surface";
    this.#surface.setAttribute("popover", "manual");
    this.#surface.setAttribute("role", "tooltip");
    this.#surface.dataset.phase = "hidden";
    this.#surface.inert = true;
    this.#rich = this.ownerDocument.createElement("span");
    this.#rich.className = "tooltip-rich-content";
    this.#rich.setAttribute("inert", "");
    this.#contentSlot = this.ownerDocument.createElement("slot");
    this.#contentSlot.name = "content";
    this.#rich.append(this.#contentSlot);
    this.#surface.append(this.#rich);
    root.append(this.#triggerSlot, this.#surface);
    this.#controller = new TooltipController(this, {
      props: () => this,
      trigger: () =>
        this.#triggerSlot.assignedElements({ flatten: true }).find(isTooltipTriggerElement) ?? null,
      richContent: () => this.#contentSlot.assignedNodes({ flatten: true }),
      richContainer: () => this.#rich,
      preview: (anchor, content) => {
        this.anchor = anchor;
        this.content = content;
      },
      retire: () => this.#retire(),
      requestOpen: (open) => this.#requestOpen(open),
    });
    this.#surface.id = this.#controller.id;
    this.#children = new MutationObserver(() => this.#controller.refresh());
    this.#triggerSlot.addEventListener("slotchange", () => this.#controller.refresh());
    this.#contentSlot.addEventListener("slotchange", () => this.#controller.contentChanged());
    this.#rich.addEventListener("pointerenter", (event) =>
      this.#controller.handleContentPointerEnter(event),
    );
    this.#rich.addEventListener("pointerleave", (event) =>
      this.#controller.handleContentPointerLeave(event),
    );
    this.#rich.addEventListener("focusin", () => this.#controller.handleFocusIn());
    this.#rich.addEventListener("focusout", (event) => this.#controller.handleFocusOut(event));
  }

  get updateComplete(): Promise<boolean> {
    return this.#pendingUpdate
      ? this.#pendingUpdate.then(() => this.#loading ?? true)
      : (this.#loading ?? Promise.resolve(true));
  }

  connectedCallback() {
    this.style.display = "contents";
    this.#children.observe(this, { childList: true });
    this.#controller.refresh();
  }

  connectedMoveCallback() {
    // Native atomic parking preserves the controller and its current presentation.
  }

  disconnectedCallback() {
    this.#retire();
    this.#children.disconnect();
    this.#controller.dispose();
    this.#runtime?.dispose();
    this.#runtime = undefined;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    const key = attributes.get(name);
    if (key) {
      const next = ["describe", "autoSize", "disabled", "openOnClick"].includes(key)
        ? value !== null
        : ["closeDelay", "hoverDismissDelay", "delay"].includes(key) && value !== null
          ? Number(value)
          : value;
      Reflect.set(this, key, next);
    }
  }

  previewForAnchor(anchor: HTMLElement | SVGElement, content: string, input: "pointer" | "focus") {
    this.#controller.previewForAnchor(anchor, content, input);
  }

  focusTriggerWithoutOpening(target: HTMLElement) {
    this.#controller.focusTriggerWithoutOpening(target);
  }

  #scheduleUpdate() {
    this.#pendingUpdate ??= Promise.resolve().then(() => {
      this.#pendingUpdate = undefined;
      if (this.isConnected) {
        this.#controller.refresh();
        this.#runtime?.update();
      }
      return true;
    });
  }

  #retire() {
    this.#wanted = false;
    if (this.#runtime) {
      this.#runtime.retire();
    } else {
      this.#controller.acceptedOpen(false);
    }
  }

  #requestOpen(open: boolean): boolean {
    this.#wanted = open;
    if (!this.#runtime && open && mountTooltipView) {
      this.#runtime = mountTooltipView(this, this.#surface, this.#rich, this.#controller);
    }
    if (this.#runtime) {
      return this.#runtime.request(open);
    }
    if (!open) {
      this.#controller.acceptedOpen(false);
      return true;
    }
    this.#controller.pendingOpen();
    viewImport ??= import("./solid/tooltip.tsx")
      .then((module) => (mountTooltipView = module.mountTooltipView))
      .catch((error: unknown) => {
        viewImport = undefined;
        throw error;
      });
    this.#loading ??= viewImport
      .then((mount) => {
        if (this.isConnected && this.#wanted) {
          this.#runtime ??= mount(this, this.#surface, this.#rich, this.#controller);
          if (!this.#runtime.request(true)) {
            this.#controller.acceptedOpen(false);
          }
        }
        return true;
      })
      .catch((error: unknown) => {
        this.#wanted = false;
        this.#controller.acceptedOpen(false);
        console.warn("OpenClaw tooltip could not load.", error);
        return false;
      })
      .finally(() => {
        this.#loading = undefined;
      });
    return true;
  }
}

export function focusWithoutTooltip(target: HTMLElement | null | undefined) {
  const tooltip = target?.closest<TooltipElement>("openclaw-tooltip");
  if (tooltip && target) {
    tooltip.focusTriggerWithoutOpening(target);
  } else {
    target?.focus();
  }
}

if (!customElements.get("openclaw-tooltip")) {
  customElements.define("openclaw-tooltip", TooltipElement);
}
if (!customElements.get("openclaw-tooltip-provider")) {
  customElements.define("openclaw-tooltip-provider", TooltipProvider);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-tooltip-provider": TooltipProvider;
    "openclaw-tooltip": TooltipElement;
  }
}
