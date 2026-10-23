/** This line predates leased handoffs, so it can never grant their authority. */
async function isImmutableManagedServiceUpdateHandoffProcess(_params: unknown): Promise<boolean> {
  return false;
}

export { isImmutableManagedServiceUpdateHandoffProcess as isCurrentManagedServiceUpdateHandoffProcess };
