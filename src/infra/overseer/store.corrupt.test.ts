import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadOverseerStoreFromDisk } from "./store.js";

describe("loadOverseerStoreFromDisk", () => {
  it("renames corrupt store and enters safe mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-overseer-"));
    const storePath = path.join(dir, "store.json");
    fs.writeFileSync(storePath, "{not json", "utf8");

    const store = loadOverseerStoreFromDisk({ overseer: { storage: { dir } } } as any);
    expect(store.safeMode?.reason).toBe("store-corrupt");
    expect(store.events.some((evt) => evt.type === "overseer.store.corrupt")).toBe(true);
    const files = fs.readdirSync(dir);
    expect(files.some((name) => name.startsWith("store.json.corrupt-"))).toBe(true);
  });
});
