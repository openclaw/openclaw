import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";
import { createTabsController, type TabsOptions } from "../lib/tabs-controller.ts";
import { rememberHubTabFocus, reclaimHubTabFocus } from "./hub-tabs-focus.ts";
import "../styles/hub-tabs.css";
import "../styles/tabs.css";
import { bindShadowStyles } from "./solid/shadow-styles.ts";
import hubStyles from "../styles/hub-tabs.css?inline";
import tabsStyles from "../styles/tabs.css?inline";

/** The remaining Lit callers share the native controller with Solid tabs. */
class TabsDirective extends AsyncDirective {
  #element?: HTMLElement;
  #options: TabsOptions = {};
  #controller?: ReturnType<typeof createTabsController>;
  #generation = 0;
  #styleTexts: readonly string[] = [tabsStyles];
  #styles?: ReturnType<typeof bindShadowStyles>;

  render(_options: TabsOptions, _styles?: readonly string[]) {
    return nothing;
  }

  override update(part: ElementPart, [options, styles = []]: [TabsOptions, (readonly string[])?]) {
    // SAFETY: The directive attaches to the native div tablist rendered below.
    this.#element = part.element as HTMLElement;
    this.#options = options;
    const styleTexts = [tabsStyles, ...styles];
    if (
      styleTexts.length !== this.#styleTexts.length ||
      styleTexts.some((css, index) => css !== this.#styleTexts[index])
    ) {
      this.#styles?.dispose();
      this.#styles = undefined;
      this.#styleTexts = styleTexts;
    }
    this.#connect();
    return nothing;
  }

  #connect() {
    if (!this.isConnected || !this.#element) {
      return;
    }
    this.#controller ??= createTabsController(this.#element, () => this.#options);
    const generation = ++this.#generation;
    queueMicrotask(() => {
      if (generation === this.#generation && this.isConnected) {
        if (this.#element) {
          this.#styles ??= bindShadowStyles(this.#element, this.#styleTexts);
          this.#styles.sync();
        }
        this.#controller?.sync();
      }
    });
  }

  protected override disconnected() {
    this.#generation += 1;
    this.#controller?.dispose();
    this.#controller = undefined;
    this.#styles?.dispose();
    this.#styles = undefined;
  }

  protected override reconnected() {
    this.#connect();
  }
}

const nativeTabs = directive(TabsDirective);

type HubTabOption<T extends string> = {
  value: T;
  label: unknown;
  badge?: unknown;
  count?: number | null;
  disabled?: boolean;
  testId?: string;
};

type HubTabsProps<T extends string> = {
  id: string;
  active: T | null;
  /** Owning selection when active is a provisional display fallback. */
  requestedActive?: T;
  tabs: ReadonlyArray<HubTabOption<T>>;
  ariaLabel: string;
  panelId: string;
  className?: string;
  /** Opts this strip into Carapace's segmented-control presentation. */
  carapace?: boolean;
  variant?: "primary" | "sub";
  onSelect: (tab: T) => void;
  onActivate?: (element: HTMLElement) => void;
};

export function renderHubTabs<T extends string>(props: HubTabsProps<T>): TemplateResult {
  const variant = props.variant ?? "primary";
  const requestedActive = props.requestedActive ?? props.active;
  const className = `oc-tabs hub-tabs hub-tabs--${variant} ${props.id}-hub-tabs${props.carapace ? " oc-segmented" : ""}${props.className ? ` ${props.className}` : ""}`;
  const fallbackFocusValue =
    props.active === null ? props.tabs.find((tab) => !tab.disabled)?.value : null;
  return html`
    <div
      role="tablist"
      class=${className}
      aria-label=${props.ariaLabel}
      ${nativeTabs(
        {
          active: props.active,
          activation: "manual",
          onActivate: (value, element, event) => {
            const tab = props.tabs.find((entry) => entry.value === value);
            if (!tab || tab.value === requestedActive) {
              return false;
            }
            if (event instanceof KeyboardEvent) {
              rememberHubTabFocus(props.id, tab.value, element);
            }
            props.onSelect(tab.value);
            props.onActivate?.(element);
            return false;
          },
        },
        [hubStyles],
      )}
    >
      ${props.tabs.map((tab) => {
        const selected = props.active === tab.value;
        return html`
          <button
            type="button"
            role="tab"
            id=${`${props.id}-tab-${tab.value}`}
            data-tab-value=${tab.value}
            aria-controls=${props.panelId}
            class="oc-tab hub-tab ${props.carapace ? "oc-segmented-item" : ""}"
            ?active=${selected}
            ?disabled=${tab.disabled}
            .tabIndex=${selected || tab.value === fallbackFocusValue ? 0 : -1}
            aria-selected=${selected ? "true" : "false"}
            data-test-id=${tab.testId ?? nothing}
            ${selected ? ref((element) => reclaimHubTabFocus(props.id, tab.value, element)) : nothing}
          >
            ${tab.label}${
              tab.count == null
                ? nothing
                : html`<span class="hub-tab__badge hub-tab__badge--count">${tab.count}</span>`
            }${tab.badge == null ? nothing : html`<span class="hub-tab__badge">${tab.badge}</span>`}
          </button>
        `;
      })}
    </div>
  `;
}
