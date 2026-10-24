import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type {
  DraftCloudProfileSelection,
  DraftPlaceCallbacks,
  DraftPlaceSnapshot,
} from "./draft-place-contract.ts";
import { environmentCloudDisabledReason } from "./hosted-environments.ts";

export type SuggestedProfileAdoption = {
  completion: Promise<void>;
  retired: Promise<void>;
  isCurrent: () => boolean;
  reportError: (error: unknown) => void;
};

export class DraftSuggestedCloudProfile {
  private adoption: PromiseWithResolvers<void> | null = null;

  constructor(
    private readonly gateway: DraftGatewayState,
    private readonly place: DraftCloudProfileSelection,
    private readonly read: () => DraftPlaceSnapshot,
    private readonly callbacks: DraftPlaceCallbacks,
  ) {}

  get pending(): boolean {
    return this.adoption !== null;
  }

  cancel() {
    this.adoption?.resolve();
    this.adoption = null;
  }

  canSelect(profileId: string): boolean {
    const snapshot = this.read();
    const profile = this.gateway.cloudProfiles.find((candidate) => candidate.id === profileId);
    return (
      !snapshot.submitting &&
      !snapshot.pendingPlacementSessionKey &&
      !this.place.requiredPlacement &&
      this.place.isAdmin() &&
      profile !== undefined &&
      !environmentCloudDisabledReason(this.place.modelControl, profile)
    );
  }

  async adopt(onStarted?: (request: SuggestedProfileAdoption) => void) {
    const snapshot = this.read();
    if (
      this.pending ||
      snapshot.submitting ||
      snapshot.pendingPlacementSessionKey ||
      this.place.requiredPlacement ||
      !this.place.isAdmin() ||
      !this.gateway.suggestedProfile ||
      environmentCloudDisabledReason(this.place.modelControl)
    ) {
      return;
    }
    const adoption = Promise.withResolvers<void>();
    this.adoption = adoption;
    this.callbacks.onError(null);
    this.callbacks.changed();
    const completion = this.settle(adoption);
    onStarted?.({
      completion,
      retired: adoption.promise,
      isCurrent: () => this.adoption === adoption,
      reportError: (error) => {
        if (this.adoption === adoption) {
          this.callbacks.onError(error instanceof Error ? error.message : String(error));
          this.callbacks.changed();
        }
      },
    });
    return completion;
  }

  private async settle(adoption: PromiseWithResolvers<void>) {
    try {
      const profileId = await this.gateway.adoptSuggestedProfile();
      if (this.adoption === adoption && profileId) {
        this.place.selectCloudProfile(profileId);
      }
    } catch (error) {
      if (this.adoption === adoption) {
        this.callbacks.onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.adoption === adoption) {
        this.cancel();
        this.callbacks.changed();
      }
    }
  }
}
