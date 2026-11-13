import type { ApplicationContext } from "../../app/context.ts";
import type { NewSessionDraft } from "./draft.ts";
import type { PaletteIdentityPreferences } from "./palette-identity-preferences.ts";
import type { PaletteSessionPreference } from "./preferences.ts";

/** A view-local selection layered over the shared, authenticated users.prefs owner. */
export class PaletteSessionPreferences {
  selection: PaletteSessionPreference | null = null;
  private edited = false;
  private observed: PaletteSessionPreference | null | undefined;
  private binding: PaletteIdentityPreferences | undefined;
  private scope = "";
  private source: ApplicationContext["gateway"] | undefined;

  constructor(
    private readonly read: () => {
      draft: NewSessionDraft | undefined;
      context: ApplicationContext | undefined;
    },
    private readonly restore: (preference: PaletteSessionPreference | null) => void,
    private readonly notify: () => void,
  ) {}

  begin() {
    this.edited = false;
    this.observed = undefined;
    this.selection = null;
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
      this.edited = false;
      this.observed = undefined;
      this.selection = null;
    }
    const binding = draft.gateway.preferenceState;
    if (binding !== this.binding) {
      this.binding = binding;
      this.observed = undefined;
    }
    const preference = binding?.mode === "remote" ? binding.palettePreference : null;
    if (this.observed === preference || binding?.mode === "loading" || !draft.agentsReady()) {
      return;
    }
    this.observed = preference;
    // Accepted edge: a model picked while an earlier start is still saving its choices
    // follows that save when it lands. Agent and project edits are kept.
    if (
      this.edited ||
      draft.submission.submitting ||
      draft.submission.pendingPlacement.sessionKey ||
      draft.submission.submissionOutcomeUnknown
    ) {
      return;
    }
    this.selection = preference;
    this.restore(this.selection);
    this.notify();
  }

  changed() {
    this.edited = true;
    const place = this.read().draft?.place;
    this.selection = place
      ? { agentId: place.agentId, selection: place.preferenceSelection() }
      : null;
    this.notify();
  }
}
