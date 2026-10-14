import type { ApplicationContext } from "../../app/context.ts";
import type { NewSessionDraftController } from "./draft-controller.ts";
import type { PaletteIdentityPreferences } from "./palette-identity-preferences.ts";
import type { PaletteSessionPreference } from "./preferences.ts";

/** A view-local selection layered over the shared, authenticated users.prefs owner. */
export class PaletteSessionPreferences {
  remember = false;
  saving = false;
  failed = false;
  selection: PaletteSessionPreference | null = null;
  private edited = false;
  private observed: PaletteSessionPreference | null | undefined;
  private binding: PaletteIdentityPreferences | undefined;
  private scope = "";
  private source: ApplicationContext["gateway"] | undefined;
  private generation = 0;
  private pending: PaletteSessionPreference | null = null;

  constructor(
    private readonly read: () => {
      draft: NewSessionDraftController | undefined;
      context: ApplicationContext | undefined;
    },
    private readonly restore: (preference: PaletteSessionPreference | null) => void,
    private readonly notify: () => void,
  ) {}

  get available() {
    const { draft } = this.read();
    return draft?.gateway.connected === true && draft.gateway.preferenceState?.mode === "remote";
  }

  begin() {
    if (this.saving || this.failed) {
      this.restore(this.selection);
      return;
    }
    this.edited = false;
    this.observed = undefined;
    this.selection = null;
    this.remember = false;
    this.failed = false;
    this.synchronize();
  }

  synchronize() {
    const { draft, context } = this.read();
    if (!draft || !context) {
      return;
    }
    const gateway = context.gateway;
    const scope = JSON.stringify([
      gateway.connection.gatewayUrl,
      gateway.snapshot.selfUser?.id ?? "",
      gateway.snapshot.hello?.auth?.recoveryScope ?? "",
    ]);
    // A transport reconnect keeps local choices. A principal or Gateway change never does.
    if (
      gateway.snapshot.phase === "connected" &&
      (this.scope !== scope || this.source !== gateway)
    ) {
      this.scope = scope;
      this.source = gateway;
      this.generation += 1;
      this.edited = false;
      this.observed = undefined;
      this.saving = false;
      this.failed = false;
      this.remember = false;
      this.selection = null;
      this.pending = null;
    }
    const binding = draft.gateway.preferenceState;
    if (binding !== this.binding) {
      const interrupted = this.saving;
      this.binding = binding;
      this.observed = undefined;
      this.generation += 1;
      this.saving = false;
      if (interrupted) {
        // The old handshake cannot confirm its queued writes for this view.
        // Preserve the latest intent for an explicit retry on the new binding.
        this.failed = true;
        this.remember = false;
        this.notify();
      }
    }
    const preference = binding?.mode === "remote" ? binding.palettePreference : null;
    if (this.observed === preference || binding?.mode === "loading" || !draft.agentsReady()) {
      return;
    }
    // A confirmation may arrive after a same-owner replacement has already loaded.
    this.observed = preference;
    if (
      this.edited ||
      draft.submission.submitting ||
      draft.submission.pendingPlacement.sessionKey ||
      draft.submission.submissionOutcomeUnknown
    ) {
      return;
    }
    this.selection = preference;
    this.remember = this.selection !== null;
    this.restore(this.selection);
    this.notify();
  }

  changed() {
    this.edited = true;
    this.selection = this.capture();
    if (this.failed && this.pending) {
      this.pending = this.selection;
    }
    if (this.remember) {
      void this.save(this.selection);
    }
    this.notify();
  }

  setRemember(value: boolean) {
    if (!this.available) {
      return;
    }
    this.edited = true;
    this.remember = value;
    this.selection = value ? this.capture() : null;
    // Only placement state resets; the prompt element, selection and submission stay intact.
    if (!value) {
      this.restore(null);
    }
    void this.save(this.selection);
    this.notify();
  }

  retry() {
    if (this.failed && this.available) {
      void this.save(this.pending);
    }
  }

  private capture(): PaletteSessionPreference | null {
    const place = this.read().draft?.place;
    if (!place?.agentId) {
      return null;
    }
    const selection = place.preferenceSelection();
    // A name belongs to one submitted draft, never to remembered launcher settings.
    delete selection.worktreeName;
    return { agentId: place.agentId, selection };
  }

  private async save(preference: PaletteSessionPreference | null) {
    const { draft } = this.read();
    if (!draft) {
      return;
    }
    const generation = ++this.generation;
    const binding = draft.gateway.preferenceState;
    this.pending = preference;
    this.saving = true;
    this.failed = false;
    const saved = await draft.gateway.savePalettePreference(preference);
    if (generation !== this.generation || binding !== draft.gateway.preferenceState) {
      return;
    }
    this.saving = false;
    this.failed = !saved;
    // Failed opt-in must not claim that the settings were remembered.
    if (!saved && preference && !binding?.palettePreference) {
      this.remember = false;
    }
    if (saved) {
      this.remember = preference !== null;
    }
    this.notify();
  }
}
