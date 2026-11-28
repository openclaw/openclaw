import { applyUserProfileEmailBinding } from "./user-profiles-internal.js";
import type {
  ProfileDisplayRow,
  UserProfileEmailBinding,
  UserProfileEmailBindingIndex,
} from "./user-profiles.types.js";

const profileBindings = new WeakMap<Map<string, ProfileDisplayRow>, UserProfileEmailBindingIndex>();

export function getCatalogEmailBindings(rows: Map<string, ProfileDisplayRow>) {
  return profileBindings.get(rows);
}

export function installCatalogEmailBindings(
  rows: Map<string, ProfileDisplayRow>,
  emailBindings: readonly UserProfileEmailBinding[],
): void {
  const bindings: UserProfileEmailBindingIndex = {
    byEmail: new Map(),
    byId: new Map(),
    emailsByProfile: new Map(),
  };
  for (const binding of emailBindings) {
    applyUserProfileEmailBinding(bindings, binding.email, binding);
  }
  profileBindings.set(rows, bindings);
}

export function applyCatalogEmailBinding(
  rows: Map<string, ProfileDisplayRow>,
  email: string,
  binding: UserProfileEmailBinding | null,
): void {
  const bindings = profileBindings.get(rows);
  if (!bindings) {
    return;
  }
  const previous = applyUserProfileEmailBinding(bindings, email, binding);
  for (const id of new Set([previous, binding?.profileId])) {
    const row = id && rows.get(id);
    if (row) {
      rows.set(row.id, { ...row });
    }
  }
}
