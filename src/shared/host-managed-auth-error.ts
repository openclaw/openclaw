export const HOST_MANAGED_AUTH_LOGIN_MESSAGE =
  "Authentication is managed by the app-server host. OpenClaw cannot start a login or replace its credentials. The host is responsible for obtaining and refreshing authentication.";

/** The host owns this credential; offering another OpenClaw login cannot repair it. */
export class HostManagedProviderAuthError extends Error {
  constructor() {
    super(HOST_MANAGED_AUTH_LOGIN_MESSAGE);
    this.name = "HostManagedProviderAuthError";
  }
}
