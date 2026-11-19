import { refreshRuntimeAuthProfileStoreAfterLogin } from "../../agents/auth-profiles.js";
import { reloadSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";

/**
 * Rebuild the in-process auth generation after an auth child persisted a credential.
 *
 * The child writes outside this process, so the published generation still predates
 * the credential and clearing it alone leaves retained local runtimes without one.
 */
export async function adoptAuthChildCredentialStore(): Promise<void> {
  await reloadSharedAuthStoreOwnership();
  clearRuntimeAuthProfileStoreSnapshots();
  await refreshRuntimeAuthProfileStoreAfterLogin();
}
