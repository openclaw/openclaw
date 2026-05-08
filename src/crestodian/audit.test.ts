import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { appendCrestodianAuditEntry, listCrestodianAuditEntriesForTests } from "./audit.js";

describe("Crestodian audit log", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    resetPluginStateStoreForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("writes audit records into SQLite core plugin state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-audit-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const auditStoreId = await appendCrestodianAuditEntry({
      operation: "config.setDefaultModel",
      summary: "Set default model to openai/gpt-5.2",
      configHashBefore: "before",
      configHashAfter: "after",
    });

    expect(auditStoreId).toBe("core:crestodian/audit");
    await expect(listCrestodianAuditEntriesForTests()).resolves.toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          operation: "config.setDefaultModel",
          summary: "Set default model to openai/gpt-5.2",
          configHashBefore: "before",
          configHashAfter: "after",
        }),
      }),
    ]);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
