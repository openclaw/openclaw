type TypingAudienceOwner = {
  generation: number;
  active: boolean;
  owns: boolean;
  onOwnershipChange: (owns: boolean) => void;
};

type TypingAudienceState = {
  owners: Map<symbol, TypingAudienceOwner>;
  reconciling: boolean;
  dirty: boolean;
};

export type TypingAudienceOwnership = {
  setActive: (active: boolean) => void;
  release: () => void;
  isOwner: () => boolean;
};

const ownersByAudience = new Map<string, TypingAudienceState>();
let nextGeneration = 0;

function notifyOwner(owner: TypingAudienceOwner, owns: boolean): void {
  try {
    owner.onOwnershipChange(owns);
  } catch {
    // A transport adapter callback cannot corrupt audience arbitration state.
  }
}

function reconcileAudience(audienceKey: string, state: TypingAudienceState): void {
  if (ownersByAudience.get(audienceKey) !== state) {
    return;
  }
  if (state.reconciling) {
    state.dirty = true;
    return;
  }
  state.reconciling = true;
  try {
    do {
      state.dirty = false;
      let selected: TypingAudienceOwner | undefined;
      for (const owner of state.owners.values()) {
        if (owner.active && (!selected || owner.generation > selected.generation)) {
          selected = owner;
        }
      }
      for (const [token, owner] of state.owners) {
        if (state.owners.get(token) !== owner) {
          continue;
        }
        const shouldOwn = owner === selected;
        if (owner.owns === shouldOwn) {
          continue;
        }
        owner.owns = shouldOwn;
        notifyOwner(owner, shouldOwn);
      }
    } while (state.dirty);
  } finally {
    state.reconciling = false;
  }
  if (ownersByAudience.get(audienceKey) === state && state.owners.size === 0) {
    ownersByAudience.delete(audienceKey);
  }
}

/**
 * Assigns one cadence owner within an explicitly opted-in public audience.
 * Entries exist only while their request controller is alive; this owns no timer.
 */
export function createTypingAudienceOwnership(params: {
  audienceKey: string | undefined;
  onOwnershipChange: (owns: boolean) => void;
}): TypingAudienceOwnership | undefined {
  const audienceKey = params.audienceKey?.trim();
  if (!audienceKey) {
    return undefined;
  }
  let state = ownersByAudience.get(audienceKey);
  if (!state) {
    state = { owners: new Map(), reconciling: false, dirty: false };
    ownersByAudience.set(audienceKey, state);
  }
  const token = Symbol(audienceKey);
  const owner: TypingAudienceOwner = {
    generation: ++nextGeneration,
    active: false,
    owns: false,
    onOwnershipChange: params.onOwnershipChange,
  };
  state.owners.set(token, owner);
  let released = false;
  return {
    setActive(active) {
      if (released || owner.active === active || state?.owners.get(token) !== owner) {
        return;
      }
      owner.active = active;
      reconcileAudience(audienceKey, state);
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      if (state?.owners.get(token) !== owner) {
        return;
      }
      state.owners.delete(token);
      if (owner.owns) {
        owner.owns = false;
        notifyOwner(owner, false);
      }
      reconcileAudience(audienceKey, state);
    },
    isOwner() {
      return !released && state?.owners.get(token) === owner && owner.owns;
    },
  };
}
