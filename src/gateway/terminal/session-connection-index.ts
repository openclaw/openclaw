/** Reverse indexes live sessions and in-flight opens by their browser connection. */
export class TerminalConnectionIndex<Value> {
  private readonly entries = new Map<string, Set<Value>>();

  add(connId: string, value: Value): void {
    const values = this.entries.get(connId) ?? new Set<Value>();
    values.add(value);
    this.entries.set(connId, values);
  }

  remove(connId: string, value: Value): void {
    const values = this.entries.get(connId);
    values?.delete(value);
    if (values?.size === 0) {
      this.entries.delete(connId);
    }
  }

  get(connId: string): Value[] | undefined {
    const values = this.entries.get(connId);
    return values ? [...values] : undefined;
  }

  clear(connId: string): void {
    this.entries.delete(connId);
  }
}
