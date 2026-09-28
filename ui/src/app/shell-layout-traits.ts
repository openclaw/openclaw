import { nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

const LAYOUT_EVENT = "openclaw-shell-layout";
const TRAITS = [
  "pluginEmbed",
  "hubHeader",
  "toolbarHeader",
  "workbench",
  "settingsPage",
  "settingsWide",
  "settingsWorkspace",
  "memoryPage",
  "logsPage",
  "activityPage",
  "terminalPage",
] as const;

export type ShellLayoutTraits = Partial<Record<(typeof TRAITS)[number], boolean>>;

class ShellLayoutEvent extends CustomEvent<ShellLayoutTraits> {
  constructor(detail: ShellLayoutTraits) {
    super(LAYOUT_EVENT, { detail, bubbles: true, composed: true });
  }
}

/** Render owners publish layout facts; the shell never inspects their private state or DOM. */
class ShellLayoutTraitsDirective extends AsyncDirective {
  private element?: Element;
  private traits: ShellLayoutTraits = {};
  private published?: ShellLayoutTraits;
  private pending = false;

  render(_traits: ShellLayoutTraits) {
    return nothing;
  }

  override update(part: ElementPart, [traits]: [ShellLayoutTraits]) {
    this.element = part.element;
    this.traits = traits;
    if (
      !this.published ||
      TRAITS.some((key) => Boolean(traits[key]) !== Boolean(this.published?.[key]))
    ) {
      this.schedule();
    }
    return nothing;
  }

  private schedule() {
    if (this.pending || !this.isConnected) {
      return;
    }
    this.pending = true;
    // Element directives run before insertion. Publish after commit; Lit's resulting
    // shell update drains in the same microtask checkpoint, before the next paint.
    queueMicrotask(() => {
      this.pending = false;
      if (this.isConnected && this.element?.isConnected) {
        this.published = this.traits;
        this.publish(this.traits);
      }
    });
  }

  private publish(detail: ShellLayoutTraits) {
    this.element?.dispatchEvent(new ShellLayoutEvent(detail));
  }

  protected override disconnected() {
    if (this.published) {
      this.publish({});
      this.published = undefined;
    }
  }

  protected override reconnected() {
    this.schedule();
  }
}

export const shellLayoutTraits = directive(ShellLayoutTraitsDirective);

export class ShellLayoutController implements ReactiveController {
  private readonly reporters = new Map<Element, ShellLayoutTraits>();
  private content?: Element;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  readonly handleChange = (event: Event) => {
    if (event.currentTarget instanceof Element) {
      this.content = event.currentTarget;
      this.record(event);
    }
  };

  private readonly handleReporterChange = (event: Event) => {
    if (event.target === event.currentTarget) {
      this.record(event);
    }
  };

  private record(event: Event) {
    const reporter = event.target;
    if (!(event instanceof ShellLayoutEvent) || !(reporter instanceof Element)) {
      return;
    }
    const traits = event.detail;
    if (this.reporters.get(reporter) === traits) {
      return;
    }
    if (reporter.isConnected && TRAITS.some((key) => traits[key])) {
      this.reporters.set(reporter, traits);
      // A detached page's clear cannot bubble. Keep the same event subscription
      // on each reporter until it clears, including hidden retained pages.
      reporter.addEventListener(LAYOUT_EVENT, this.handleReporterChange);
    } else {
      if (!this.reporters.has(reporter)) {
        return;
      }
      this.remove(reporter);
    }
    this.host.requestUpdate();
  }

  get current(): ShellLayoutTraits {
    const traits: ShellLayoutTraits = {};
    for (const [reporter, reported] of this.reporters) {
      if (!reporter.isConnected || !this.content?.contains(reporter)) {
        this.remove(reporter);
        continue;
      }
      for (const key of TRAITS) {
        if (reported[key]) {
          traits[key] = true;
        }
      }
    }
    return traits;
  }

  private remove(reporter: Element) {
    reporter.removeEventListener(LAYOUT_EVENT, this.handleReporterChange);
    this.reporters.delete(reporter);
  }

  hostDisconnected() {
    for (const reporter of this.reporters.keys()) {
      this.remove(reporter);
    }
    this.content = undefined;
  }
}
