import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationManager } from "./manager.js";
import type { Notification, NotificationListener } from "./types.js";

describe("NotificationManager", () => {
  let tmpDir: string;
  let manager: NotificationManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-notif-test-"));
    manager = new NotificationManager(tmpDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a notification", async () => {
    const n = await manager.notify({
      title: "New message",
      body: "Hello from Telegram",
      channel: "telegram",
    });
    expect(n).not.toBeNull();
    expect(n?.title).toBe("New message");
    expect(n?.read).toBe(false);
    expect(n?.category).toBe("message");
    expect(n?.priority).toBe("normal");
  });

  it("stores and retrieves notifications", async () => {
    await manager.notify({ title: "Test 1", body: "Body 1" });
    await manager.notify({ title: "Test 2", body: "Body 2" });

    const all = manager.getAll();
    expect(all).toHaveLength(2);
  });

  it("filters unread notifications", async () => {
    const n1 = await manager.notify({ title: "Test 1", body: "Body 1" });
    await manager.notify({ title: "Test 2", body: "Body 2" });
    await manager.markRead(n1!.id);

    const unread = manager.getUnread();
    expect(unread).toHaveLength(1);
    expect(unread[0].title).toBe("Test 2");
  });

  it("marks all as read", async () => {
    await manager.notify({ title: "Test 1", body: "Body 1" });
    await manager.notify({ title: "Test 2", body: "Body 2" });

    const count = await manager.markAllRead();
    expect(count).toBe(2);
    expect(manager.getUnread()).toHaveLength(0);
  });

  it("clears all notifications", async () => {
    await manager.notify({ title: "Test 1", body: "Body 1" });
    await manager.notify({ title: "Test 2", body: "Body 2" });

    const count = await manager.clear();
    expect(count).toBe(2);
    expect(manager.getAll()).toHaveLength(0);
  });

  it("respects priority threshold", async () => {
    await manager.updatePreferences({ minPriority: "high" });
    const low = await manager.notify({
      title: "Low",
      body: "Low priority",
      priority: "low",
    });
    const high = await manager.notify({
      title: "High",
      body: "High priority",
      priority: "high",
    });

    expect(low).toBeNull(); // suppressed
    expect(high).not.toBeNull();
  });

  it("suppresses when disabled", async () => {
    await manager.updatePreferences({ enabled: false });
    const n = await manager.notify({ title: "Test", body: "Body" });
    expect(n).toBeNull();
  });

  it("dispatches to listeners", async () => {
    const received: Notification[] = [];
    const listener: NotificationListener = {
      onNotification: (n) => {
        received.push(n);
      },
    };
    manager.addListener(listener);

    await manager.notify({ title: "Test", body: "Body" });
    expect(received).toHaveLength(1);
    expect(received[0].title).toBe("Test");
  });

  it("removes listeners", async () => {
    const received: Notification[] = [];
    const listener: NotificationListener = {
      onNotification: (n) => {
        received.push(n);
      },
    };
    manager.addListener(listener);
    manager.removeListener(listener);

    await manager.notify({ title: "Test", body: "Body" });
    expect(received).toHaveLength(0);
  });

  it("groups notifications", async () => {
    await manager.notify({ title: "T1", body: "B1", channel: "telegram" });
    await manager.notify({ title: "T2", body: "B2", channel: "telegram" });
    await manager.notify({ title: "T3", body: "B3", channel: "discord" });

    const groups = manager.getGrouped();
    expect(groups.get("telegram")).toHaveLength(2);
    expect(groups.get("discord")).toHaveLength(1);
  });

  it("filters by category", async () => {
    await manager.notify({ title: "Msg", body: "Message", category: "message" });
    await manager.notify({ title: "Err", body: "Error", category: "error" });

    const errors = manager.getAll({ category: "error" });
    expect(errors).toHaveLength(1);
    expect(errors[0].title).toBe("Err");
  });

  it("persists and reloads from disk", async () => {
    await manager.notify({ title: "Persisted", body: "Saved to disk" });

    // Create a new manager pointing at the same dir
    const manager2 = new NotificationManager(tmpDir);
    const all = manager2.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("Persisted");
  });

  it("persists and reloads preferences", async () => {
    await manager.updatePreferences({ minPriority: "high", groupBy: "agent" });

    const manager2 = new NotificationManager(tmpDir);
    const prefs = manager2.getPreferences();
    expect(prefs.minPriority).toBe("high");
    expect(prefs.groupBy).toBe("agent");
  });

  it("handles quiet hours (overnight range)", async () => {
    // Set quiet hours that should be active now
    const now = new Date();
    const startMinutes = now.getHours() * 60 + now.getMinutes() - 30;
    const endMinutes = startMinutes + 60;
    const formatTime = (mins: number) => {
      const h = Math.floor(((mins % 1440) + 1440) % 1440 / 60);
      const m = ((mins % 60) + 60) % 60;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    };

    await manager.updatePreferences({
      quietHours: {
        enabled: true,
        start: formatTime(startMinutes),
        end: formatTime(endMinutes),
      },
    });

    // Normal priority should be suppressed during quiet hours
    const normal = await manager.notify({
      title: "Normal",
      body: "Normal priority",
      priority: "normal",
    });
    expect(normal).toBeNull();

    // Urgent should bypass quiet hours
    const urgent = await manager.notify({
      title: "Urgent",
      body: "Urgent priority",
      priority: "urgent",
    });
    expect(urgent).not.toBeNull();
  });

  it("includes actions in notifications", async () => {
    const n = await manager.notify({
      title: "Tool approval",
      body: "Agent wants to run: deploy",
      category: "tool-approval",
      actions: [
        { id: "approve", label: "Approve", type: "approve" },
        { id: "deny", label: "Deny", type: "dismiss" },
      ],
    });

    expect(n?.actions).toHaveLength(2);
    expect(n?.actions?.[0].type).toBe("approve");
  });
});
