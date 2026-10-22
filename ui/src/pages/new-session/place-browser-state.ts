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
  readCompletion: Promise<string | null> | null = null;
  error: string | null = null;
  activeIndex = -1;
  private token = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  constructor(
    private readonly listDirectory: (path?: string) => Promise<FsListDirResult>,
    private readonly changed: () => void,
    private readonly onListing?: (listing: FsListDirResult) => void,
  ) {}

  navigate(path: string | undefined, mode: "initial" | "navigation" = "navigation"): Promise<void> {
    this.cancelPending();
    this.draft = path ?? "";
    this.activeIndex = -1;
    this.error = null;
    this.loading = true;
    const completion = this.load(path, mode, this.token);
    this.readCompletion = completion;
    this.changed();
    return completion.then(() => {});
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
      this.readCompletion = new Promise((resolve) => {
        this.timer = globalThis.setTimeout(() => {
          this.timer = undefined;
          void this.load(split.directory, "typing", requestId).then(resolve);
        }, PICKER_INPUT_DEBOUNCE_MS);
      });
    }
    this.changed();
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
    this.changed();
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
    this.readCompletion = null;
  }

  private async load(
    path: string | undefined,
    mode: "initial" | "navigation" | "typing",
    requestId: number,
  ): Promise<string | null> {
    const draftAtRequest = this.draft;
    try {
      const listing = await this.listDirectory(path);
      if (requestId !== this.token) {
        return null;
      }
      this.listing = listing;
      if (mode !== "typing" && this.draft === draftAtRequest) {
        this.draft = listing.path;
      }
      // Typed loads keep the requested spelling. A different Gateway-canonicalized write-scope
      // symlink path intentionally shows "No matching folders" instead of children.
      this.activeIndex = -1;
      this.onListing?.(listing);
    } catch (error) {
      if (requestId !== this.token) {
        return null;
      }
      // Typed directories may be incomplete; only explicit navigation reports a hard failure.
      if (mode === "initial" && path && isMissingFolderError(error)) {
        this.draft = "";
        return await this.load(undefined, "navigation", requestId);
      } else if (mode !== "typing") {
        return readMissingScopeError(error)?.missingScope
          ? t("newSession.browseRequiresAdmin")
          : t("newSession.browserLoadFailed");
      }
    } finally {
      if (requestId === this.token) {
        this.loading = false;
        this.changed();
      }
    }
    return null;
  }
}
