import { HovercardOwner } from "./link-reader-hovercard-owner.ts";
import type { HovercardMethods, HovercardProperties } from "./link-reader-hovercard.types.ts";
import { EMPTY_LINK_READERS, LINK_READER_HOVERCARD_PROVIDER_TAG } from "./link-reader-target.ts";

const defaults: HovercardProperties = {
  client: null,
  agentId: undefined,
  sessionKey: undefined,
  readers: EMPTY_LINK_READERS,
  previewSeeds: [],
  pagePreviewContext: undefined,
  claimedReaders: EMPTY_LINK_READERS,
};

// This host owns behavior, not its caller's DOM. Lazy activation must not mount a
// second renderer over the transcript and disturb the pointer that requested it.
export class LinkReaderHovercardProvider
  extends HTMLElement
  implements HovercardProperties, HovercardMethods
{
  declare client: HovercardProperties["client"];
  declare agentId: HovercardProperties["agentId"];
  declare sessionKey: HovercardProperties["sessionKey"];
  declare readers: HovercardProperties["readers"];
  declare previewSeeds: HovercardProperties["previewSeeds"];
  declare pagePreviewContext: HovercardProperties["pagePreviewContext"];
  declare claimedReaders: HovercardProperties["claimedReaders"];
  readonly #values = new Map<string, unknown>();
  readonly #owner: HovercardOwner;
  #initialized = false;

  constructor() {
    super();
    // SAFETY: Defaults declares every property in the typed host contract.
    for (const key of Object.keys(defaults) as (keyof HovercardProperties)[]) {
      const initial = Object.hasOwn(this, key) ? Reflect.get(this, key) : defaults[key];
      this.#values.set(key, initial);
      Object.defineProperty(this, key, {
        configurable: true,
        get: () => this.#values.get(key),
        set: (value: unknown) => {
          if (!Object.is(this.#values.get(key), value)) {
            this.#values.set(key, value);
            this.#owner.propertyChanged(key);
          }
        },
      });
    }
    this.#owner = new HovercardOwner(this, LinkReaderHovercardProvider);
  }

  get updateComplete(): Promise<boolean> {
    return Promise.resolve(true);
  }

  connectedCallback(): void {
    if (!this.#initialized) {
      this.#initialized = true;
      // SAFETY: Defaults declares exactly the host properties replayed on upgrade.
      for (const key of Object.keys(defaults) as (keyof HovercardProperties)[]) {
        this.#owner.propertyChanged(key);
      }
    }
    this.#owner.connect();
  }

  connectedMoveCallback(): void {
    // Atomic pane parking retains the same owner and caller-owned subtree.
  }

  disconnectedCallback(): void {
    this.#owner.disconnect();
  }

  activateFromBootstrap(...args: Parameters<HovercardMethods["activateFromBootstrap"]>): void {
    this.#owner.activateFromBootstrap(...args);
  }

  prefetch(...args: Parameters<HovercardMethods["prefetch"]>): Promise<void> {
    return this.#owner.prefetch(...args);
  }
}

customElements.define(LINK_READER_HOVERCARD_PROVIDER_TAG, LinkReaderHovercardProvider);
