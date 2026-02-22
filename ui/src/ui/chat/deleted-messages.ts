const PREFIX = "openclaw:deleted:";

export class DeletedMessages {
  private key: string;
  private _keys = new Set<string>();

  constructor(sessionKey: string) {
    this.key = PREFIX + sessionKey;
    this.load();
  }

  has(key: string): boolean {
    return this._keys.has(key);
  }

  delete(key: string): void {
    this._keys.add(key);
    this.save();
  }

  restore(key: string): void {
    this._keys.delete(key);
    this.save();
  }

  clear(): void {
    this._keys.clear();
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
        this._keys = new Set(arr.filter((s) => typeof s === "string"));
      }
    } catch {
      // ignore
    }
  }

  private save(): void {
    localStorage.setItem(this.key, JSON.stringify([...this._keys]));
  }
}
