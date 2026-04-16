import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import * as backupShared from "./backup-shared.js";
import { resolveBackupPlanFromPaths } from "./backup-shared.js";

export const tarCreateMock = vi.fn();
export const backupVerifyCommandMock = vi.fn();

class MockPack {
  private options: { file: string; onWriteEntry?: (entry: unknown) => void };
  private files: string[] = [];
  private stream?: NodeJS.WritableStream & NodeJS.EventEmitter;
  private errorListeners: Array<(err: unknown) => void> = [];

  constructor(options: { file: string; onWriteEntry?: (entry: unknown) => void }) {
    this.options = options;
  }

  pipe(stream: NodeJS.WritableStream & NodeJS.EventEmitter) {
    this.stream = stream;
    return stream;
  }

  add(file: string) {
    this.files.push(file);
  }

  on(event: string, listener: (err: unknown) => void) {
    if (event === "error") {
      this.errorListeners.push(listener);
    }
    return this;
  }

  async end() {
    try {
      await tarCreateMock(this.options, this.files);
      this.stream?.emit("close" as never);
    } catch (err) {
      for (const listener of this.errorListeners) {
        listener(err);
      }
      this.stream?.emit("error" as never, err);
    }
  }
}

vi.mock("tar", () => ({
  c: tarCreateMock,
  Pack: MockPack,
}));

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

export function createBackupTestRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
}

export async function mockStateOnlyBackupPlan(stateDir: string) {
  await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
  vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockResolvedValue(
    await resolveBackupPlanFromPaths({
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      oauthDir: path.join(stateDir, "credentials"),
      includeWorkspace: false,
      configInsideState: true,
      oauthInsideState: true,
      nowMs: 123,
    }),
  );
}
