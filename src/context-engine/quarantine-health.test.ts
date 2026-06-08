// Context-engine quarantine health tests cover cross-process status visibility.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";
import { clearContextEngineRuntimeQuarantine, listContextEngineQuarantines } from "./registry.js";

async function withLiveSiblingProcess<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    stdio: "ignore",
  });
  if (!child.pid) {
    throw new Error("failed to start live sibling process");
  }
  try {
    return await fn(child.pid);
  } finally {
    child.kill();
  }
}

describe("context engine quarantine health", () => {
  it("lists persisted runtime quarantines when local process state is empty", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
      clearContextEngineRuntimeQuarantine();
      recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "intentional bootstrap failure",
        failedAt: new Date(123),
      });

      expect(listContextEngineQuarantines()).toEqual([
        {
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "intentional bootstrap failure",
          failedAt: new Date(123),
        },
      ]);
    });
  });

  it("clears only the current process record while preserving live sibling quarantines", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-", async ({ stateDir }) => {
      await withLiveSiblingProcess(async (siblingProcessId) => {
        const filePath = path.join(stateDir, "context-engine", "runtime-quarantines.json");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
          filePath,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              records: [
                {
                  engineId: "lossless-claw",
                  owner: "plugin:lossless-claw",
                  operation: "bootstrap",
                  reason: "current process failure",
                  failedAtMs: 123,
                  processId: process.pid,
                  recordedAtMs: 456,
                },
                {
                  engineId: "lossless-claw",
                  owner: "plugin:lossless-claw",
                  operation: "bootstrap",
                  reason: "sibling process failure",
                  failedAtMs: 789,
                  processId: siblingProcessId,
                  recordedAtMs: 1_000,
                },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        clearPersistedContextEngineQuarantineForProcess("lossless-claw", process.pid);

        expect(listContextEngineQuarantines()).toEqual([
          {
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "sibling process failure",
            failedAt: new Date(789),
          },
        ]);
      });
    });
  });

  it("clears all current process records while preserving live sibling quarantines", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-", async ({ stateDir }) => {
      await withLiveSiblingProcess(async (siblingProcessId) => {
        const filePath = path.join(stateDir, "context-engine", "runtime-quarantines.json");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
          filePath,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              records: [
                {
                  engineId: "local-a",
                  operation: "bootstrap",
                  reason: "current process failure a",
                  failedAtMs: 123,
                  processId: process.pid,
                  recordedAtMs: 456,
                },
                {
                  engineId: "local-b",
                  operation: "assemble",
                  reason: "current process failure b",
                  failedAtMs: 234,
                  processId: process.pid,
                  recordedAtMs: 567,
                },
                {
                  engineId: "lossless-claw",
                  owner: "plugin:lossless-claw",
                  operation: "bootstrap",
                  reason: "sibling process failure",
                  failedAtMs: 789,
                  processId: siblingProcessId,
                  recordedAtMs: 1_000,
                },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        clearContextEngineRuntimeQuarantine();

        expect(listContextEngineQuarantines()).toEqual([
          {
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "sibling process failure",
            failedAt: new Date(789),
          },
        ]);
      });
    });
  });
});
