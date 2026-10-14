import { ContextEvent } from "@lit/context";
import { html, LitElement, nothing, type ChildPart } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import type {
  ControlUiSurface,
  ControlUiSurfaceProps,
} from "../../../src/plugin-sdk/control-ui.js";
import { applicationContext } from "../app/context.ts";
import { livePresentation, type PresentationValue } from "../lit/presentation-binding.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

export type ViewKind = "pages" | "panels" | "accessories" | "widgets" | "replacements";

class PluginSurfaceDirective extends AsyncDirective {
  private host?: LitElement;
  private part?: ChildPart;
  private contextTarget?: Element;
  private unsubscribeContext?: () => void;
  private runtime?: ControlUiPluginCapability;
  private unsubscribe?: () => void;
  private args?: [ControlUiSurface, unknown, unknown, PresentationValue, unknown];
  private pending = false;

  override update(
    part: ChildPart,
    args: [ControlUiSurface, unknown, unknown, PresentationValue, unknown],
  ) {
    this.args = args;
    this.part = part;
    const host = part.options?.host;
    const nextHost = host instanceof LitElement ? host : undefined;
    if (this.host !== nextHost) {
      this.disconnect();
      this.host = nextHost;
    }
    this.connect();
    // Solid hands the marker range through a fragment before attaching its DOM.
    if (!this.contextTarget) {
      this.refresh();
    }
    return this.render(...args);
  }

  private connect() {
    if (!this.isConnected) {
      return;
    }
    const target = this.host ?? this.part?.startNode?.parentElement;
    if (!target?.isConnected || target === this.contextTarget) {
      return;
    }
    this.disconnect();
    // A reconnect must resolve the current provider before selecting a view.
    this.runtime = undefined;
    this.contextTarget = target;
    target.dispatchEvent(
      new ContextEvent(
        applicationContext,
        target,
        (context, unsubscribe) => {
          if (this.unsubscribeContext !== unsubscribe) {
            this.unsubscribeContext?.();
            this.unsubscribeContext = unsubscribe;
          }
          if (this.runtime === context?.plugins) {
            return;
          }
          this.unsubscribe?.();
          this.runtime = context?.plugins;
          this.unsubscribe = this.runtime?.subscribe(() => this.refresh());
          this.refresh();
        },
        true,
      ),
    );
  }

  private refresh() {
    if (this.pending) {
      return;
    }
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (this.isConnected && this.args) {
        this.connect();
        this.setValue(this.render(...this.args));
      }
    });
  }

  private disconnect() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeContext?.();
    this.unsubscribeContext = undefined;
    this.contextTarget = undefined;
    // Parked ranges still update their retained view while subscriptions sleep.
  }

  override disconnected() {
    this.disconnect();
  }
  override reconnected() {
    this.connect();
    this.refresh();
  }

  override render(
    surface: ControlUiSurface,
    props: unknown,
    defaultView: unknown,
    presented: PresentationValue,
    replacementCompanion: unknown,
  ) {
    // Built-in renderers remain synchronous and do not create a component for
    // every transcript row. Only a selected replacement owns a DOM mount.
    return this.runtime?.selectedReplacement(surface)
      ? html`<openclaw-plugin-view
          ?data-plugin-composer=${surface === "composer"}
          .surface=${surface}
          .props=${props}
          .defaultView=${defaultView}
          .replacementCompanion=${replacementCompanion}
          .defaultHost=${this.host}
          .presented=${livePresentation(presented)}
        ></openclaw-plugin-view>`
      : // A nested AsyncDirective must remain a template child: replacing its
        // value must not retire this surface's own connection registration.
        html`${defaultView}`;
  }
}

const pluginSurface = directive(PluginSurfaceDirective);

export function renderPluginSurface<S extends ControlUiSurface>(
  surface: S,
  props: ControlUiSurfaceProps[S],
  defaultView: unknown,
  presented: PresentationValue = true,
  replacementCompanion: unknown = nothing,
) {
  return pluginSurface(surface, props, defaultView, presented, replacementCompanion);
}

export function renderPluginContribution(
  kind: Exclude<ViewKind, "replacements">,
  key: string,
  props: unknown,
  presented: PresentationValue = true,
) {
  return html`<openclaw-plugin-view
    .kind=${kind}
    .contributionKey=${key}
    .props=${props}
    .presented=${livePresentation(presented)}
  ></openclaw-plugin-view>`;
}
