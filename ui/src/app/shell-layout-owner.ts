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

const contentOwners = new WeakMap<Element, ShellLayoutOwner>();

export function shellLayoutOwnerForHost(host: Element): ShellLayoutOwner | undefined {
  const content = host.isConnected ? host.closest("main.content") : null;
  return content ? contentOwners.get(content) : undefined;
}

/** Both renderers publish to this synchronous owner before measuring descendants. */
export class ShellLayoutOwner {
  private readonly reporters = new Map<object, { host: Element; traits: ShellLayoutTraits }>();
  private content?: Element;

  constructor(private readonly onChange: () => void = () => {}) {}

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
    this.onChange();
  }

  clear(token: object) {
    if (this.reporters.delete(token)) {
      this.apply();
      this.onChange();
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
