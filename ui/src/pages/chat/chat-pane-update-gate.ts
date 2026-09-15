// The first Lit update must render even while hidden; later hidden work parks.
// Disconnect releases the waiter so reconnect can schedule in its new lifecycle.
type ChatPaneUpdateGateHost = {
  readonly hasUpdated: boolean;
  readonly isConnected: boolean;
  readonly visuallyPresented: boolean;
};

export class ChatPaneUpdateGate {
  private resume: (() => void) | undefined;

  async waitWhileBlocked(host: ChatPaneUpdateGateHost): Promise<void> {
    while (
      host.hasUpdated &&
      host.isConnected &&
      (document.visibilityState === "hidden" || !host.visuallyPresented)
    ) {
      await new Promise<void>((resolve) => {
        this.resume = resolve;
      });
    }
  }

  release(): void {
    const resume = this.resume;
    this.resume = undefined;
    resume?.();
  }
}
