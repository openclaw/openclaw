/** Templates install by `@publisher/slug`, like skills; creator-published packages keep an unscoped stored name. */
export function clawHubTemplateRef(packageName: string, ownerHandle: string | undefined): string {
  return packageName.startsWith("@") || !ownerHandle
    ? packageName
    : `@${ownerHandle}/${packageName}`;
}

export function matchesClawHubTemplateRef(
  requestedName: string | undefined,
  packageName: string,
  ownerHandle: string | undefined,
): boolean {
  return (
    requestedName === packageName || requestedName === clawHubTemplateRef(packageName, ownerHandle)
  );
}
