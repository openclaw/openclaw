const PREFIX = "openclaw:pinned:";

export class PinnedMessages {
  private key: string;
  private _indices = new Set<number>();

  constructor(sessionKey: string) {
    this.key = PREFIX + sessionKey;
    this.load();
  }

  get indices(): Set<number> {
    return this._indices;
  }

  has(index: number): boolean {
    return this._indices.has(index);
  }

  pin(index: number): void {
    this._indices.add(index);
    this.save();
  }

  unpin(index: number): void {
    this._indices.delete(index);
    this.save();
  }

  toggle(index: number): void {
    if (this._indices.has(index)) {
      this.unpin(index);
    } else {
      this.pin(index);
    }
  }

  clear(): void {
    this._indices.clear();
    this.save();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) {
        return;
      }
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        this._indices = new Set(arr.filter((n) => typeof n === "number"));
      }
    } catch {
      // ignore
    }
  }

  private save(): void {
    localStorage.setItem(this.key, JSON.stringify([...this._indices]));
  }
}
