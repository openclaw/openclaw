import type { DesktopConnectionHandle } from "./desktop-client.ts";

export class TestConnection implements DesktopConnectionHandle {
  readonly events: string[] = [];
  disconnect() {}
  disableInput() {}
  setPresented() {
    return true;
  }
  sendBackspace() {
    this.events.push("backspace");
  }
  sendKeyboardEvent(event: KeyboardEvent) {
    this.events.push(`${event.type}:${event.code}`);
  }
  sendText(text: string) {
    this.events.push(`text:${text}`);
  }
  setSizingMode() {}
}
