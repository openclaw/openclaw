import { readMissingScopeError } from "@openclaw/gateway-client/browser";
import type {
  FsDirEntry,
  FsListDirResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isMissingFolderError } from "./folder-validation.ts";
import { isAbsolutePath, sameAbsolutePath } from "./path.ts";
import { resolvePlaceBrowserView, splitBrowserDraft } from "./place-browser-view.ts";

registerNewSessionSetupEnglish();

export const PICKER_INPUT_DEBOUNCE_MS = 300;

export class PlaceBrowserState {
  listing: FsListDirResult | null = null;
  draft = "";
  loading = false;
  error: string | null = null;
  activeIndex = -1;
  private token = 0;
  private listingGenerationValue = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  constructor(
    private readonly listDirectory: (path?: string) => Promise<FsListDirResult>,
    private readonly requestUpdate: () => void,
    private readonly onListing?: (listing: FsListDirResult) => void,
  ) {}

  get listingGeneration(): number {
    return this.listingGenerationValue;
  }

  navigate(path: string | undefined, mode: "initial" | "navigation" = "navigation"): Promise<void> {
    this.cancelPending();
    this.draft = path ?? "";
    this.activeIndex = -1;
    this.error = null;
    this.loading = true;
    this.requestUpdate();
    return this.load(path, mode, this.token);
  }

  setDraft(value: string) {
    this.cancelPending();
    this.draft = value;
    this.activeIndex = -1;
    this.error = null;
    const split = splitBrowserDraft(value.trim());
    this.loading = Boolean(split && !this.draftInLoadedDirectory());
    if (split && this.loading) {
      const requestId = this.token;
      // Mark loading before the debounce so an unloaded directory never flashes "no matches".
      this.timer = globalThis.setTimeout(() => {
        this.timer = undefined;
        void this.load(split.directory, "typing", requestId);
      }, PICKER_INPUT_DEBOUNCE_MS);
    }
    this.requestUpdate();
  }

  draftInLoadedDirectory(): boolean {
    if (!this.listing) {
      return false;
    }
    const draft = this.draft.trim();
    const split = splitBrowserDraft(draft);
    return (
      !split ||
      sameAbsolutePath(draft, this.listing.path) ||
      sameAbsolutePath(split.directory, this.listing.path)
    );
  }

  moveHighlight(delta: 1 | -1) {
    const count = this.view().entries.length;
    if (count === 0) {
      return;
    }
    this.activeIndex =
      this.activeIndex < 0
        ? delta === 1
          ? 0
          : count - 1
        : (this.activeIndex + delta + count) % count;
    this.requestUpdate();
  }

  highlightedEntry(): FsDirEntry | undefined {
    return this.view().entries[this.activeIndex];
  }

  completeHighlighted(): boolean {
    const entry = this.highlightedEntry() ?? this.view().entries[0];
    if (!entry || this.draft.trim() === entry.path) {
      return false;
    }
    this.setDraft(entry.path);
    return true;
  }

  async activate(): Promise<void> {
    const path = this.usablePath();
    // A relative draft still shows the loaded listing; its highlight must not stand in for the draft.
    if (path === null) {
      return;
    }
    await this.navigate(this.highlightedEntry()?.path ?? (path || undefined));
  }

  usablePath(): string | null {
    const draft = this.draft.trim();
    return !draft || isAbsolutePath(draft) ? draft : null;
  }

  reset() {
    this.cancelPending();
    this.listing = null;
    this.listingGenerationValue += 1;
    this.draft = "";
    this.loading = false;
    this.error = null;
    this.activeIndex = -1;
  }

  view() {
    const draft = this.draft.trim();
    return resolvePlaceBrowserView({ listing: this.listing, draft, loading: this.loading });
  }

  private cancelPending() {
    // Retire in-flight responses immediately, including while the next load is still debouncing.
    this.token += 1;
    globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async load(
    path: string | undefined,
    mode: "initial" | "navigation" | "typing",
    requestId: number,
  ) {
    const draftAtRequest = this.draft;
    try {
      const listing = await this.listDirectory(path);
      if (requestId !== this.token) {
        return;
      }
      this.listing = listing;
      this.listingGenerationValue += 1;
      if (mode !== "typing" && this.draft === draftAtRequest) {
        this.draft = listing.path;
      }
      // Typed loads keep the requested spelling. A different Gateway-canonicalized write-scope
      // symlink path intentionally shows "No matching folders" instead of children.
      this.activeIndex = -1;
      this.onListing?.(listing);
    } catch (error) {
      if (requestId !== this.token) {
        return;
      }
      // Typed directories may be incomplete; only explicit navigation reports a hard failure.
      if (mode === "initial" && path && isMissingFolderError(error)) {
        this.draft = "";
        await this.load(undefined, "navigation", requestId);
      } else if (mode !== "typing") {
        this.error = readMissingScopeError(error)?.missingScope
          ? t("newSession.browseRequiresAdmin")
          : t("newSession.browserLoadFailed");
      }
    } finally {
      if (requestId === this.token) {
        this.loading = false;
        this.requestUpdate();
      }
    }
  }
}
