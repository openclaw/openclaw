import {
  clearCloudSessionRecovery,
  readCloudSessionRecovery,
  type CloudSessionRecovery,
} from "./cloud-recovery.ts";

export function resolveScope(
  snapshot: {
    client: { recoveryScope?: string; recoveryScopeReady?: boolean } | null;
    connected: boolean;
  },
  current: string,
  firstBind: boolean,
): { next: string; changed: boolean } {
  const next =
    snapshot.connected && snapshot.client?.recoveryScopeReady
      ? (snapshot.client.recoveryScope ?? "")
      : current;
  return { next, changed: !firstBind && snapshot.connected && current !== next };
}

export class PendingCloudRecoveryState {
  sessionKey = "";
  messageId = "";
  message = "";
  attachments: unknown[] | undefined;
  profileId = "";
  agentId = "";
  gatewayUrl = "";
  recoveryScope = "";
  retryAllowed = false;
  restored = false;

  clear() {
    clearCloudSessionRecovery(this.gatewayUrl, this.recoveryScope, this.sessionKey);
    this.reset();
  }

  clearFor(gatewayUrl: string, recoveryScope: string, sessionKey: string) {
    clearCloudSessionRecovery(gatewayUrl, recoveryScope, sessionKey);
    if (this.owns(gatewayUrl, recoveryScope, sessionKey)) {
      this.reset();
    }
  }

  owns(gatewayUrl: string, recoveryScope: string, sessionKey: string): boolean {
    return (
      this.gatewayUrl === gatewayUrl &&
      this.recoveryScope === recoveryScope &&
      this.sessionKey === sessionKey
    );
  }

  reset() {
    this.sessionKey = "";
    this.messageId = "";
    this.message = "";
    this.attachments = undefined;
    this.profileId = "";
    this.agentId = "";
    this.gatewayUrl = "";
    this.recoveryScope = "";
    this.retryAllowed = false;
    this.restored = false;
  }

  restore(gatewayUrl: string, recoveryScope: string): CloudSessionRecovery | null {
    const recovery = readCloudSessionRecovery(gatewayUrl, recoveryScope);
    if (!recovery) {
      return null;
    }
    this.sessionKey = recovery.sessionKey;
    this.messageId = recovery.messageId;
    this.message = recovery.message;
    this.attachments = recovery.attachments;
    this.profileId = recovery.profileId;
    this.agentId = recovery.agentId;
    this.gatewayUrl = recovery.gatewayUrl;
    this.recoveryScope = recovery.recoveryScope;
    this.retryAllowed = true;
    this.restored = true;
    return recovery;
  }
}
