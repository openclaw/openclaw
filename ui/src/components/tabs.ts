import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { createTabsController, type TabsOptions } from "../lib/tabs-controller.ts";
import { bindShadowStyles } from "./solid/shadow-styles.ts";
import tabsStyles from "../styles/tabs.css?inline";
import "../styles/tabs.css";

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

export const nativeTabs = directive(TabsDirective);
