/**
 * The protected DACL a private Windows path is created with, as SDDL.
 *
 * Kept free of native bindings so the descriptor can be checked on any OS; the
 * Win32 side lives in `windows-private-directory.ts`.
 */
export type PrivateWindowsSddlParams = {
  /** String SID of the creating token's user; also the owner. */
  userSid: string;
  /**
   * String SID of the creating token's AppContainer, or null outside one.
   *
   * Inside an AppContainer, an access check passes only when the DACL grants
   * both the token's user (or a group) and its AppContainer SID (or a
   * capability it holds). Without this ACE the creating process cannot reopen
   * what it just created.
   */
  appContainerSid: string | null;
  /** Directories inherit their ACEs to children; files do not. */
  inherit: boolean;
};

export function buildPrivateWindowsSddl(params: PrivateWindowsSddlParams): string {
  const flags = params.inherit ? "OICI" : "";
  const grant = (sid: string) => `(A;${flags};FA;;;${sid})`;
  const aces = [grant(params.userSid), grant("SY"), grant("BA")];
  if (params.appContainerSid !== null) {
    aces.push(grant(params.appContainerSid));
  }
  return `O:${params.userSid}D:P${aces.join("")}`;
}
