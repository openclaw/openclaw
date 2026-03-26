import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest, migrateSessionStoreToDirectory } from "../sessions.js";
import { loadSessionStoreSummary } from "./store-summary.js";

describe("loadSessionStoreSummary", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-summary-test-"));
  });

  beforeEach(() => {
    clearSessionStoreCacheForTest();
  });

  afterAll(async () => {
    clearSessionStoreCacheForTest();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reads migrated directory-backed stores", async () => {
    const storePath = path.join(fixtureRoot, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:whatsapp:+15550000001": {
            sessionId: "sess-1",
            updatedAt: 123,
            lastChannel: "whatsapp",
            lastTo: "+15550000001",
            thinkingLevel: "high",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(migrateSessionStoreToDirectory(storePath)).resolves.toMatchObject({
      outcome: "migrated",
    });

    expect(loadSessionStoreSummary(storePath)).toEqual({
      "agent:main:whatsapp:+15550000001": {
        lastChannel: "whatsapp",
        lastTo: "+15550000001",
        updatedAt: 123,
      },
    });
  });
});
