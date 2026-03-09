const MAX = 50;

export class InputHistory {
  private items: string[] = [];
  private cursor = -1;

  push(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (this.items[this.items.length - 1] === trimmed) {
      return;
    }
    this.items.push(trimmed);
    if (this.items.length > MAX) {
      this.items.shift();
    }
    this.cursor = -1;
  }

  up(): string | null {
    if (this.items.length === 0) {
      return null;
    }
    if (this.cursor < 0) {
      this.cursor = this.items.length - 1;
    } else if (this.cursor > 0) {
      this.cursor--;
    }
    return this.items[this.cursor] ?? null;
  }

  down(): string | null {
    if (this.cursor < 0) {
      return null;
    }
    this.cursor++;
    if (this.cursor >= this.items.length) {
      this.cursor = -1;
      return null;
    }
    return this.items[this.cursor] ?? null;
  }

  reset(): void {
    this.cursor = -1;
  }
}
