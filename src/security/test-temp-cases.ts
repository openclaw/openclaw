import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class AsyncTempCaseFactory {
  private caseId = 0;
  private fixtureRoot = "";
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  async setup() {
    this.fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), this.prefix));
  }

  async cleanup() {
    if (!this.fixtureRoot) {
      return;
    }
    await fs.rm(this.fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  async makeTmpDir(label: string) {
    const dir = path.join(this.fixtureRoot, `case-${this.caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
}
