import { nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

const TRAITS = [
  ["pluginEmbed", "content--plugin-embed"],
  ["hubHeader", "content--hub-header"],
  ["toolbarHeader", "content--toolbar-header"],
  ["workbench", "content--workbench"],
  ["settingsPage", "content--settings-page"],
  ["settingsWide", "content--settings-wide"],
  ["settingsWorkspace", "content--settings-workspace"],
  ["memoryPage", "content--memory-page"],
  ["logsPage", "content--logs-page"],
  ["activityPage", "content--activity-page"],
  ["terminalPage", "content--terminal-page"],
] as const;

export type ShellLayoutTraits = Partial<Record<(typeof TRAITS)[number][0], boolean>>;

const contentControllers = new WeakMap<Element, ShellLayoutController>();

/** Render owners publish layout facts before their descendants can measure layout. */
class ShellLayoutTraitsDirective extends AsyncDirective {
  private host?: Element;
  private traits: ShellLayoutTraits = {};
  private controller?: ShellLayoutController;

  render(_traits: ShellLayoutTraits) {
    return nothing;
  }

  override update(part: ElementPart, [traits]: [ShellLayoutTraits]) {
    this.host = part.options?.host instanceof Element ? part.options.host : undefined;
    this.traits = traits;
    this.publish();
    return nothing;
  }

  private publish() {
    // The new element is still detached. Its connected rendering host already
    // identifies the content scope, including templates rendered by the outlet.
    const content =
      this.isConnected && this.host?.isConnected ? this.host.closest("main.content") : null;
    const controller = content ? contentControllers.get(content) : undefined;
    if (controller !== this.controller) {
      this.controller?.clear(this);
      this.controller = controller;
    }
    if (this.host) {
      this.controller?.record(this, this.host, this.traits);
    }
  }

  protected override disconnected() {
    this.controller?.clear(this);
    this.controller = undefined;
  }

  protected override reconnected() {
    this.publish();
  }
}

export const shellLayoutTraits = directive(ShellLayoutTraitsDirective);

export class ShellLayoutController implements ReactiveController {
  private readonly reporters = new Map<object, { host: Element; traits: ShellLayoutTraits }>();
  private content?: Element;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  readonly contentRef = (content: Element | undefined) => {
    if (content === this.content) {
      return;
    }
    if (this.content) {
      contentControllers.delete(this.content);
    }
    this.content = content;
    if (content) {
      contentControllers.set(content, this);
      this.apply();
    }
  };

  record(token: object, host: Element, traits: ShellLayoutTraits) {
    if (
      !host.isConnected ||
      !this.content?.contains(host) ||
      !TRAITS.some(([key]) => traits[key])
    ) {
      this.clear(token);
      return;
    }
    const previous = this.reporters.get(token);
    if (
      previous?.host === host &&
      TRAITS.every(([key]) => Boolean(previous.traits[key]) === Boolean(traits[key]))
    ) {
      return;
    }
    this.reporters.set(token, { host, traits: { ...traits } });
    this.apply();
    this.host.requestUpdate();
  }

  clear(token: object) {
    if (this.reporters.delete(token)) {
      this.apply();
      this.host.requestUpdate();
    }
  }

  get current(): ShellLayoutTraits {
    const traits: ShellLayoutTraits = {};
    for (const [token, reporter] of this.reporters) {
      if (!reporter.host.isConnected || !this.content?.contains(reporter.host)) {
        this.reporters.delete(token);
        continue;
      }
      for (const [key] of TRAITS) {
        if (reporter.traits[key]) {
          traits[key] = true;
        }
      }
    }
    return traits;
  }

  get className(): string {
    const traits = this.current;
    return TRAITS.filter(([key]) => traits[key])
      .map(([, className]) => className)
      .join(" ");
  }

  private apply() {
    const traits = this.current;
    for (const [key, className] of TRAITS) {
      this.content?.classList.toggle(className, Boolean(traits[key]));
    }
  }

  hostDisconnected() {
    this.reporters.clear();
    this.apply();
  }
}
