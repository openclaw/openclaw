import { describe, it, expect } from "vitest";
import { buildSnapshotFromRaw } from "./snapshot-from-raw.js";

describe("buildSnapshotFromRaw", () => {
  it("produces valid ConfigFileSnapshot from JSON string", async () => {
    const raw = '{"gateway":{"mode":"local"}}';
    const snap = await buildSnapshotFromRaw(raw, "nacos:openclaw.json", {
      env: process.env,
    });
    expect(snap.path).toBe("nacos:openclaw.json");
    expect(snap.exists).toBe(true);
    expect(snap.raw).toBe(raw);
    expect(snap.valid).toBe(true);
    expect(snap.config?.gateway?.mode).toBe("local");
  });
});
