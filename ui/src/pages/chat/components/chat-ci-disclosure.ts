import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";

export type ChatCiDisclosureProps = {
  gateway?: ApplicationGateway;
  pullRequest?: ControlUiSessionPullRequest;
  sessionKey: string;
  presented: boolean;
};

/** The disclosure owns visibility; the two CI projections own their request fences. */
export abstract class ChatCiDisclosure<
  Props extends ChatCiDisclosureProps = ChatCiDisclosureProps,
> {
  protected disclosure: HTMLDetailsElement | null = null;
  private active = false;
  private previous = new Map<string, unknown>();
  protected abstract readonly handleVisibility: () => void;
  protected abstract disconnect(): void;
  protected abstract syncProps(changed: ReadonlyMap<string, unknown>): void;
  protected abstract refreshIfVisible(changed: ReadonlyMap<string, unknown>): void;

  constructor(
    protected readonly props: Props,
    protected readonly host: HTMLElement,
    private readonly notify: () => void,
  ) {}

  protected get gateway() {
    return this.props.gateway;
  }
  protected get pullRequest() {
    return this.props.pullRequest;
  }
  protected get sessionKey() {
    return this.props.sessionKey;
  }
  protected get presented() {
    return this.props.presented;
  }
  protected get isConnected() {
    return this.active && this.host.isConnected;
  }
  protected get ownerDocument() {
    return this.host.ownerDocument;
  }

  connect(extra: Record<string, unknown> = {}): void {
    this.active = true;
    this.disclosure = this.host.closest<HTMLDetailsElement>(".chat-pr__checks");
    this.disclosure?.addEventListener("toggle", this.handleToggle);
    this.ownerDocument.addEventListener("visibilitychange", this.handleVisibility);
    this.sync(extra);
  }

  sync(extra: Record<string, unknown> = {}): void {
    if (!this.active) {
      return;
    }
    const next = {
      gateway: this.gateway,
      pullRequest: this.pullRequest,
      sessionKey: this.sessionKey,
      presented: this.presented,
      ...extra,
    };
    const changed = new Map<string, unknown>();
    for (const [key, value] of Object.entries(next)) {
      if (!this.previous.has(key) || this.previous.get(key) !== value) {
        changed.set(key, this.previous.get(key));
      }
      this.previous.set(key, value);
    }
    this.syncProps(changed);
    this.notify();
    this.refreshIfVisible(changed);
  }

  dispose(): void {
    this.active = false;
    this.disclosure?.removeEventListener("toggle", this.handleToggle);
    this.ownerDocument.removeEventListener("visibilitychange", this.handleVisibility);
    this.disconnect();
  }

  protected publish(): void {
    this.notify();
    queueMicrotask(() => {
      if (this.active) {
        this.refreshIfVisible(new Map());
      }
    });
  }

  protected get visible(): boolean {
    return (
      this.isConnected &&
      this.presented &&
      this.disclosure?.open === true &&
      this.ownerDocument.visibilityState !== "hidden"
    );
  }

  private readonly handleToggle = (event: Event): void => {
    if (event.target === this.disclosure) {
      this.handleVisibility();
    }
  };
}
