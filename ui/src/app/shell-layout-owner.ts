const TRAITS = [
  ["pluginEmbed", "content--plugin-embed"],
  ["hubHeader", "content--hub-header"],
  ["toolbarHeader", "content--toolbar-header"],
  ["settingsPage", "content--settings-page"],
  ["settingsWide", "content--settings-wide"],
  ["settingsWorkspace", "content--settings-workspace"],
  ["cronEditor", "content--cron-editor"],
  ["memoryPage", "content--memory-page"],
  ["logsPage", "content--logs-page"],
  ["activityPage", "content--activity-page"],
  ["terminalPage", "content--terminal-page"],
  ["portalsPage", "content--portals-page"],
] as const;

export type ShellLayoutTraits = Partial<Record<(typeof TRAITS)[number][0], boolean>>;

const contentOwners = new WeakMap<Element, ShellLayoutOwner>();

export function shellLayoutOwnerForHost(host: Element): ShellLayoutOwner | undefined {
  const content = host.isConnected ? host.closest("main.content") : null;
  return content ? contentOwners.get(content) : undefined;
}

/** Both renderers publish to this synchronous owner before measuring descendants. */
export class ShellLayoutOwner {
  private readonly reporters = new Map<object, { host: Element; traits: ShellLayoutTraits }>();
  private readonly footerControls = new Set<HTMLElement>();
  private content?: Element;

  readonly contentRef = (content: Element | undefined) => {
    if (content === this.content) {
      return;
    }
    if (this.content) {
      contentOwners.delete(this.content);
    }
    this.content = content;
    if (content) {
      contentOwners.set(content, this);
      this.apply();
    }
  };

  record(token: object, host: Element, traits: ShellLayoutTraits) {
    // Native shells assemble their page descendants before connecting to the document.
    if (!this.content?.contains(host) || !TRAITS.some(([key]) => traits[key])) {
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
  }

  clear(token: object) {
    if (this.reporters.delete(token)) {
      this.apply();
    }
  }

  registerFooterControlSurface(element: HTMLElement): () => void {
    this.footerControls.add(element);
    return () => this.footerControls.delete(element);
  }

  readonly footerControlsOverlap = (
    bounds: Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">,
  ): boolean => {
    for (const surface of this.footerControls) {
      if (
        !surface.isConnected ||
        !this.content?.contains(surface) ||
        !surface.checkVisibility({ checkOpacity: true, visibilityProperty: true })
      ) {
        continue;
      }
      const rect = surface.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left < bounds.right &&
        rect.right > bounds.left &&
        rect.top < bounds.bottom &&
        rect.bottom > bounds.top
      ) {
        return true;
      }
    }
    return false;
  };

  get current(): ShellLayoutTraits {
    const traits: ShellLayoutTraits = {};
    for (const [token, reporter] of this.reporters) {
      if (!this.content?.contains(reporter.host)) {
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

  private apply() {
    const traits = this.current;
    for (const [key, className] of TRAITS) {
      this.content?.classList.toggle(className, Boolean(traits[key]));
    }
  }

  dispose() {
    this.footerControls.clear();
    this.reporters.clear();
    this.apply();
  }
}
