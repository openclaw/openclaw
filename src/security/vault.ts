import { type Finding } from "./patterns.js";

export class TokenVault {
  private map: Record<string, string>;
  private reverse: Record<string, string>;
  private counter: number;

  constructor(existing?: Record<string, string>) {
    this.map = existing || {};
    this.reverse = {};
    for (const [k, v] of Object.entries(this.map)) {
      this.reverse[v] = k;
    }
    this.counter = Object.keys(this.map).length;
  }

  private nextToken(): string {
    this.counter++;
    return `[VAULT_${this.counter}]`;
  }

  public importMapping(token: string, value: string): void {
    if (!this.map[token]) {
      this.map[token] = value;
      this.reverse[value] = token;
      const num = Number.parseInt(token.replace(/\[VAULT_|\]/g, ""), 10);
      if (num > this.counter) {
        this.counter = num;
      }
    }
  }

  public redact(text: string, findings: Finding[]): string {
    if (!findings || findings.length === 0) {
      return text;
    }

    let result = text;
    for (const finding of findings) {
      const fullValue = finding.fullValue;

      let token = this.reverse[fullValue];
      if (!token) {
        token = this.nextToken();
        this.map[token] = fullValue;
        this.reverse[fullValue] = token;
      }

      // Replace all occurrences of this specific value in the text
      // Safe to use split/join since fullValue might contain regex special chars
      result = result.split(fullValue).join(token);
    }

    return result;
  }

  public redactKnown(text: string): string {
    let result = text;
    for (const [original, token] of Object.entries(this.reverse)) {
      result = result.split(original).join(token);
    }
    return result;
  }

  public restore(text: string): string {
    let result = text;
    for (const [token, original] of Object.entries(this.map)) {
      result = result.split(token).join(original);
    }
    return result;
  }

  public toDict(): Record<string, string> {
    return { ...this.map };
  }
}
