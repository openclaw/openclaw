import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JitsiBridgeRoomStore } from "./room-store.js";

const tempDirs: string[] = [];

async function createStore(): Promise<JitsiBridgeRoomStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-jitsi-bridge-"));
  tempDirs.push(dir);
  return new JitsiBridgeRoomStore(dir, "https://meet.jit.si");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("JitsiBridgeRoomStore", () => {
  it("creates and updates rooms", async () => {
    const store = await createStore();
    const room = await store.create({
      topic: "Investor Briefing",
      displayName: "Meeting Assistant",
      inviteEmail: "assistant@example.com",
      realtimeModel: "gpt-realtime-mini",
    });

    expect(room.briefing).toBe("");
    const updated = await store.update(room.id, (current) => ({
      ...current,
      briefing: "Neue Fakten",
      status: "briefed",
    }));
    expect(updated.briefing).toBe("Neue Fakten");
    expect(await store.list()).toHaveLength(1);
  });
});
