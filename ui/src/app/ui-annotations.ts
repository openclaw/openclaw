import type { UiCommand } from "@openclaw/gateway-protocol";
import { html, svg, nothing, render } from "lit";
import { t } from "../i18n/index.ts";
import "../styles/ui-annotations.css";
import { placeAnnotation, type AnnotationBox as Box } from "./ui-annotation-layout.ts";

type Guide = Extract<UiCommand, { kind: "annotate" }>;
type Annotation = Guide["annotations"][number];
const controls = {
  "side-panel": ".chat-side-panel-toggle",
  "panel-new": ".side-panel-type-menu__trigger",
  "terminal-new": "[data-guide-target='terminal-new']",
  settings: "wa-dropdown-item[value='command:settings']",
  "agent-menu": "[data-guide-target='agent-menu']",
  "agent-new": ".agents-create-btn, wa-dropdown-item[value='command:new-agent']",
  "session-new": ".sidebar-brand__new-thread, .sidebar-session-toolbar__button.sidebar-new-session",
} satisfies Record<Extract<Annotation["target"], { control: string }>["control"], string>;
const normalized = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim();

/** Targets are app-owned light-DOM controls and copy, never selectors or iframe content. */
function findAnnotationTarget(root: ParentNode, target: Annotation["target"]): Element | null {
  let candidates: Element[];
  if ("control" in target) {
    candidates = Array.from(root.querySelectorAll(controls[target.control]));
  } else if ("sessionKey" in target) {
    candidates = Array.from(root.querySelectorAll("[data-session-key]")).filter(
      (el) => el.getAttribute("data-session-key") === target.sessionKey,
    );
  } else {
    const text = normalized(target.text);
    candidates = Array.from(
      root.querySelectorAll(
        "button, a, [role='button'], wa-dropdown-item, p, li, h1, h2, h3, span",
      ),
    ).filter(
      (el) =>
        !el.closest(".ui-guide") &&
        [el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent].some(
          (value) => normalized(value) === text,
        ),
    );
    candidates = candidates.filter(
      (el) => !candidates.some((other) => other !== el && other.contains(el)),
    );
  }
  candidates = candidates.filter((el) => visibleBox(el) !== null);
  return candidates.length === 1 ? candidates[0]! : null;
}

function visibleBox(el: Element): Box | null {
  if (!el.isConnected || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  let left = Math.max(0, rect.left),
    top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right),
    bottom = Math.min(innerHeight, rect.bottom);
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent),
      clip = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  if (right - left < 4 || bottom - top < 4) {
    return null;
  }
  const hit = document
    .elementsFromPoint((left + right) / 2, (top + bottom) / 2)
    .find((element) => !element.closest(".ui-guide"));
  if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function arrowPath(label: Box, target: Box) {
  const lx = label.x + label.width / 2,
    ly = label.y + label.height / 2;
  const tx = target.x + target.width / 2,
    ty = target.y + target.height / 2;
  const dx = tx - lx,
    dy = ty - ly;
  const ls = 1 / Math.max(Math.abs(dx) / (label.width / 2), Math.abs(dy) / (label.height / 2));
  const ts =
    1 / Math.max(Math.abs(dx) / (target.width / 2 + 9), Math.abs(dy) / (target.height / 2 + 9));
  const sx = lx + dx * ls,
    sy = ly + dy * ls,
    ex = tx - dx * ts,
    ey = ty - dy * ts;
  const qx = sx + (ex - sx) * 0.25 - (ey - sy) * 0.2,
    qy = sy + (ey - sy) * 0.25 + (ex - sx) * 0.2;
  const angle = Math.atan2(ey - qy, ex - qx),
    bx = ex - Math.cos(angle) * 19,
    by = ey - Math.sin(angle) * 19;
  return {
    line: `M ${sx} ${sy} Q ${qx} ${qy} ${bx} ${by}`,
    head: `M ${ex} ${ey} L ${bx - Math.sin(angle) * 10} ${by + Math.cos(angle) * 10} L ${bx + Math.sin(angle) * 10} ${by - Math.cos(angle) * 10} Z`,
  };
}

/** A guide is owned by one connection/session and is never persisted or replayed. */
export class UiAnnotations {
  private readonly layer = document.createElement("div");
  private readonly events = new AbortController();
  private readonly observer: MutationObserver;
  private readonly resize: ResizeObserver;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout>;
  private disposed = false;
  private targets: Element[] = [];
  constructor(
    private readonly root: HTMLElement,
    private readonly annotations: Annotation[],
    durationSeconds: number,
    private readonly isCurrent: () => boolean,
  ) {
    this.layer.className = "ui-guide";
    this.layer.popover = "manual";
    document.body.append(this.layer);
    this.layer.showPopover();
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    this.resize = new ResizeObserver(() => this.schedule());
    this.resize.observe(root);
    const options = { capture: true, signal: this.events.signal };
    window.addEventListener("resize", this.schedule, options);
    window.addEventListener("scroll", this.schedule, options);
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) {
          this.dispose();
        }
      },
      options,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !event.isComposing) {
          this.dispose();
        }
      },
      options,
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (this.targets.some((target) => event.composedPath().includes(target))) {
          this.dispose();
        }
      },
      options,
    );
    this.timer = setTimeout(() => this.dispose(), durationSeconds * 1000);
    this.schedule();
  }
  private readonly schedule = () => {
    if (!this.disposed && !this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
    }
  };
  private draw() {
    if (!this.isCurrent() || document.hidden || !this.root.isConnected) {
      this.dispose();
      return;
    }
    const targets = this.annotations.map((annotation) =>
      findAnnotationTarget(this.root, annotation.target),
    );
    const nextTargets = targets.filter((target): target is Element => target !== null);
    const targetsChanged =
      nextTargets.length !== this.targets.length ||
      nextTargets.some((target, i) => target !== this.targets[i]);
    if (targetsChanged) {
      this.resize.disconnect();
      this.resize.observe(this.root);
      for (const target of nextTargets) {
        this.resize.observe(target);
      }
      this.targets = nextTargets;
    }
    render(
      html`<div class="ui-guide__status" role="status">
          ${t("uiGuide.title")}<button
            @click=${() => this.dispose()}
            aria-label=${t("uiGuide.dismiss")}
          >
            ×
          </button>
        </div>
        ${this.annotations.map((annotation, index) => html`<div class=${"ui-guide__label ui-guide__label--" + (annotation.color ?? "coral")} role="status" data-guide-index=${index}><span class="ui-guide__number">${index + 1}</span><span>${annotation.text}${!targets[index] ? html`<small>${t("uiGuide.waiting")}</small>` : nothing}</span></div>`)}
        <div class="ui-guide__shapes"></div>`,
      this.layer,
    );
    const labels = Array.from(this.layer.querySelectorAll<HTMLElement>(".ui-guide__label"));
    const occupied: Box[] = [];
    const boxes = targets.map((target) => (target ? visibleBox(target) : null));
    this.layer.classList.remove("ui-guide--stacked");
    const positions = labels.map((label, index) => {
      const position = placeAnnotation(
        boxes[index] ?? null,
        label.getBoundingClientRect(),
        { width: innerWidth, height: innerHeight },
        occupied,
      );
      if (position) {
        occupied.push(position);
      }
      return position;
    });
    const stacked = positions.some((position) => position === null);
    this.layer.classList.toggle("ui-guide--stacked", stacked);
    const shapes = this.annotations.map((annotation, index) => {
      const label = labels[index],
        position = positions[index],
        box = boxes[index];
      if (!label) {
        return nothing;
      }
      label.style.left = !stacked && position ? position.x + "px" : "";
      label.style.top = !stacked && position ? position.y + "px" : "";
      if (stacked || !position || !box) {
        return nothing;
      }
      const arrow = arrowPath(position, box);
      return svg`<svg class=${"ui-guide__shape ui-guide__shape--" + (annotation.color ?? "coral")} aria-hidden="true" viewBox=${"0 0 " + innerWidth + " " + innerHeight}>
        ${annotation.style !== "note" ? svg`<rect class="ui-guide__outline" x=${box.x - 5} y=${box.y - 5} width=${box.width + 10} height=${box.height + 10} rx="9"/>` : nothing}
        ${annotation.style !== "outline" ? svg`<path class="ui-guide__keyline" d=${arrow.line}/><path class="ui-guide__shaft" d=${arrow.line}/><path class="ui-guide__head" d=${arrow.head}/>` : nothing}
      </svg>`;
    });
    render(shapes, this.layer.querySelector<HTMLDivElement>(".ui-guide__shapes")!);
    // Native menu popovers occupy the top layer, above every z-index. Re-present
    // this nonmodal, non-focusing guide after layout so its pointer stays visible.
    if (targetsChanged && !this.layer.contains(document.activeElement)) {
      this.layer.hidePopover();
      this.layer.showPopover();
    }
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.events.abort();
    this.observer.disconnect();
    this.resize.disconnect();
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    this.layer.remove();
  }
}
