import type {
  UsersPrefsGetResult,
  UsersPrefsSetResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import {
  createVoiceSnippetCatalog,
  editVoiceSnippetCatalog,
  exportVoiceSnippetCatalog,
  validateVoiceSnippetCatalog,
  VoiceSnippetValidationError,
  VOICE_SNIPPETS_PREFERENCE_KEY,
  type VoiceSnippetCatalog,
  type VoiceSnippetEdit,
  type VoiceSnippetValidationCode,
} from "../../../../src/shared/voice-snippets.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { saveUserPreferences } from "../../app/user-prefs-cache.ts";

export type VoiceSnippetCatalogError = VoiceSnippetValidationCode | "unavailable" | "identity";

/** One dialog's authorized cache; the existing profile preference worker owns writes. */
export class VoiceSnippetCatalogView {
  readonly changes = createChangeListeners();
  readonly subscribe = this.changes.subscribe;
  catalog: VoiceSnippetCatalog | null = null;
  busy = false;
  error: VoiceSnippetCatalogError | null = null;
  collisionIds: readonly string[] = [];
  private stored: VoiceSnippetCatalog | null = null;
  private readonly connection: Promise<boolean>;
  private retired = false;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly signal: AbortSignal,
  ) {
    this.connection = client.connectSent;
  }

  private current(): boolean {
    return (
      !this.retired &&
      !this.signal.aborted &&
      this.client.connected &&
      this.client.connectSent === this.connection
    );
  }

  private retire(error: "identity" | "unavailable"): void {
    this.retired = true;
    this.catalog = null;
    this.stored = null;
    this.collisionIds = [];
    this.error = error;
  }

  get available(): boolean {
    return this.current();
  }

  private async run(
    operation: () => Promise<boolean>,
    preserveEditorOnFailure = false,
  ): Promise<boolean> {
    if (this.busy) {
      return false;
    }
    if (!this.current()) {
      this.retire(this.error === "identity" ? "identity" : "unavailable");
      if (!this.signal.aborted) {
        this.changes.publish();
      }
      return false;
    }
    this.busy = true;
    this.error = null;
    this.collisionIds = [];
    this.changes.publish();
    try {
      const succeeded = await operation();
      return this.current() && succeeded;
    } catch (error) {
      if (this.current()) {
        if (error instanceof VoiceSnippetValidationError) {
          this.error = error.code;
          this.collisionIds = error.ids;
        } else if (preserveEditorOnFailure) {
          // Keep the edit and its original compare-and-set value. A manual
          // reload can reconcile an uncertain write; never replay it here.
          this.error = "unavailable";
        } else {
          this.retire("unavailable");
        }
      }
      return false;
    } finally {
      this.busy = false;
      if (!this.current() && !this.retired) {
        this.retire("unavailable");
      }
      if (!this.signal.aborted) {
        this.changes.publish();
      }
    }
  }

  load(): Promise<boolean> {
    return this.run(async () => {
      const result = await this.client.request<UsersPrefsGetResult>("users.prefs.get", {
        keys: [VOICE_SNIPPETS_PREFERENCE_KEY],
      });
      if (!this.current()) {
        return false;
      }
      if (result.status !== "ok") {
        this.retire("identity");
        return false;
      }
      const value = result.entries[VOICE_SNIPPETS_PREFERENCE_KEY];
      const catalog =
        value === undefined ? createVoiceSnippetCatalog() : validateVoiceSnippetCatalog(value);
      this.stored = value === undefined ? null : catalog;
      this.catalog = catalog;
      return true;
    });
  }

  edit(edit: VoiceSnippetEdit): Promise<boolean> {
    return this.run(async () => {
      if (!this.catalog) {
        return false;
      }
      const next = editVoiceSnippetCatalog(this.catalog, edit);
      const result: UsersPrefsSetResult = await saveUserPreferences(this.client, {
        entries: { [VOICE_SNIPPETS_PREFERENCE_KEY]: next },
        expectedEntries: { [VOICE_SNIPPETS_PREFERENCE_KEY]: this.stored },
      });
      if (!this.current()) {
        return false;
      }
      if (result.status !== "ok") {
        if (result.status === "conflict") {
          this.error = "conflict";
        } else {
          this.retire("identity");
        }
        return false;
      }
      this.stored = next;
      this.catalog = next;
      return true;
    }, true);
  }

  async export(): Promise<string | null> {
    // Export reuses current profile admission; a retained dialog is not an offline grant.
    if (!(await this.load()) || !this.current() || !this.catalog) {
      return null;
    }
    return exportVoiceSnippetCatalog(this.catalog);
  }
}
