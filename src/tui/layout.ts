import type { Component } from "@mariozechner/pi-tui";

export class ChatLayout implements Component {
  constructor(
    private header: Component,
    private messages: Component,
    private status: Component,
    private input: Component,
  ) {}

  invalidate(): void {
    this.header.invalidate?.();
    this.messages.invalidate?.();
    this.status.invalidate?.();
    this.input.invalidate?.();
  }

  render(width: number): string[] {
    const rows = process.stdout.rows ?? 24;
    const headerLines = this.header.render(width);
    const statusLines = this.status.render(width);
    const inputLines = this.input.render(width);

    const reserved =
      headerLines.length + statusLines.length + inputLines.length;
    const available = Math.max(rows - reserved, 0);

    const messageLines = this.messages.render(width);
    const slicedMessages =
      available > 0
        ? messageLines.slice(Math.max(0, messageLines.length - available))
        : [];

    const lines = [
      ...headerLines,
      ...slicedMessages,
      ...statusLines,
      ...inputLines,
    ];
    if (lines.length < rows) {
      const padding = Array.from({ length: rows - lines.length }, () => "");
      return [...lines, ...padding];
    }
    return lines.slice(0, rows);
  }
}
