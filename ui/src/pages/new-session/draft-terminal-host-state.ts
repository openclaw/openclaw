export class DraftTerminalHostState {
  private hostIdValue = "gateway:local";
  private initialized = false;

  get hostId(): string {
    return this.hostIdValue;
  }

  get onNode(): boolean {
    return this.hostIdValue.startsWith("node:");
  }

  select(hostId: string, blocked: boolean, onChange: () => void) {
    if (blocked) {
      return;
    }
    this.initialized = true;
    if (hostId === this.hostIdValue) {
      return;
    }
    this.hostIdValue = hostId;
    onChange();
  }

  synchronize(hosts: Array<{ hostId: string }> | undefined, select: (hostId: string) => void) {
    if (this.initialized || !hosts?.length) {
      return;
    }
    select(hosts.find((host) => host.hostId === this.hostIdValue)?.hostId ?? hosts[0]!.hostId);
  }

  reset() {
    this.hostIdValue = "gateway:local";
    this.initialized = false;
  }
}
