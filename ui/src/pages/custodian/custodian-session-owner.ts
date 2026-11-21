import type { ApplicationGateway } from "../../app/context.ts";

export class CustodianSessionOwner {
  private lastDeviceToken = "";

  key(gateway: ApplicationGateway | null): string {
    if (!gateway) {
      return "";
    }
    const { gatewayUrl, token, password, bootstrapToken } = gateway.connection;
    const auth = gateway.snapshot.hello?.auth;
    if (auth) {
      this.lastDeviceToken = auth.deviceToken ?? "";
    }
    return JSON.stringify([gatewayUrl, token, password, bootstrapToken, this.lastDeviceToken]);
  }
}
