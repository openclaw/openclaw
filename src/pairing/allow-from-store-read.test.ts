import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearAllowFromStoreReadCacheForTest,
  readChannelAllowFromStoreEntriesSync,
} from "./allow-from-store-read.js";
import { addChannelAllowFromStoreEntry } from "./pairing-store.js";

let fixtureRoot = "";
let caseId = 0;

function makeEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
  };
}

function makeHomeDir(): string {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function writeAllowFromStore(params: {
  channel: "telegram";
  env: NodeJS.ProcessEnv;
  accountId?: string;
  allowFrom: string[];
}): Promise<void> {
  for (const entry of params.allowFrom) {
    await addChannelAllowFromStoreEntry({
      channel: params.channel,
      env: params.env,
      accountId: params.accountId,
      entry,
    });
  }
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-allow-from-read-"));
});

afterAll(() => {
  if (fixtureRoot) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  clearAllowFromStoreReadCacheForTest();
});

describe("allow-from-store-read", () => {
  it("reads default account entries from SQLite", async () => {
    const env = makeEnv(makeHomeDir());
    await writeAllowFromStore({
      channel: "telegram",
      env,
      accountId: "default",
      allowFrom: [" scoped-a ", "scoped-a", "legacy-b"],
    });

    expect(readChannelAllowFromStoreEntriesSync("telegram", env)).toEqual(["scoped-a", "legacy-b"]);
  });

  it("keeps non-default account reads scoped", async () => {
    const env = makeEnv(makeHomeDir());
    await writeAllowFromStore({
      channel: "telegram",
      env,
      allowFrom: ["default-a"],
    });
    await writeAllowFromStore({
      channel: "telegram",
      env,
      accountId: "work",
      allowFrom: [" work-a ", "work-b"],
    });

    expect(readChannelAllowFromStoreEntriesSync("telegram", env, "work")).toEqual([
      "work-a",
      "work-b",
    ]);
  });
});
