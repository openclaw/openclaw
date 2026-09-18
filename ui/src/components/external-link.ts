import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { t } from "../i18n/index.ts";
import {
  externalLinkOpensInPanel,
  subscribeExternalLinkPresentation,
} from "../lib/external-link-presentation.ts";
import { isExternalLinkHref } from "../lib/external-link.ts";
import { icons } from "./icons.ts";

class ExternalLinkIndicator extends AsyncDirective {
  private unsubscribe?: () => void;

  override update() {
    if (this.isConnected && !this.unsubscribe) {
      this.subscribe();
    }
    return this.render();
  }

  render() {
    return externalLinkOpensInPanel()
      ? nothing
      : html`<span
          class="external-link-indicator"
          role="img"
          aria-label=${t("common.opensInNewTab")}
          >${icons.arrowUpRight}</span
        >`;
  }

  private subscribe() {
    this.unsubscribe = subscribeExternalLinkPresentation(() => this.setValue(this.render()));
  }

  protected override disconnected() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  protected override reconnected() {
    this.subscribe();
    this.setValue(this.render());
  }
}

const externalLinkIndicator = directive(ExternalLinkIndicator);

export function renderExternalLinkLabel(
  label: string,
  href?: string,
  surface: "text" | "menu" = "text",
): string | TemplateResult {
  if (href !== undefined && !isExternalLinkHref(href)) {
    return label;
  }
  if (surface === "menu") {
    return html`<span class="external-link-label external-link-label--menu"
      >${label}${externalLinkIndicator()}</span
    >`;
  }
  const tailStart = label.lastIndexOf(" ") + 1;
  return html`<span class="external-link-label"
    >${label.slice(0, tailStart)}<span class="external-link-tail"
      >${label.slice(tailStart)}${externalLinkIndicator()}</span
    ></span
  >`;
}
