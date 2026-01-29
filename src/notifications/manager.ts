import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  PRIORITY_ORDER,
  type Notification,
  type NotificationCategory,
  type NotificationListener,
  type NotificationPreferences,
  type NotificationPriority,
} from "./types.js";

const NOTIFICATIONS_FILENAME = "notifications.json";
const PREFS_FILENAME = "notification-prefs.json";
const MAX_STORED_NOTIFICATIONS = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class NotificationManager {
  private listeners: NotificationListener[] = [];
  private notifications: Notification[] = [];
  private preferences: NotificationPreferences;
  private stateDir: string;
  private loaded = false;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? resolveStateDir();
    this.preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }

  /** Register a listener that receives notifications (e.g. push provider, websocket). */
  addListener(listener: NotificationListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: NotificationListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /** Load stored notifications and preferences from disk. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;

    // Load preferences
    const prefsPath = path.join(this.stateDir, PREFS_FILENAME);
    try {
      const raw = fs.readFileSync(prefsPath, "utf-8");
      const parsed = JSON.parse(raw) as NotificationPreferences;
      this.preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, ...parsed };
    } catch {
      // use defaults
    }

    // Load stored notifications
    const notifPath = path.join(this.stateDir, NOTIFICATIONS_FILENAME);
    try {
      const raw = fs.readFileSync(notifPath, "utf-8");
      const parsed = JSON.parse(raw) as Notification[];
      if (Array.isArray(parsed)) {
        this.notifications = parsed;
      }
    } catch {
      // no stored notifications
    }

    // Prune old notifications
    this.pruneOldNotifications();
  }

  /** Create and dispatch a notification. */
  async notify(params: {
    title: string;
    body: string;
    priority?: NotificationPriority;
    category?: NotificationCategory;
    channel?: string;
    agentId?: string;
    sessionKey?: string;
    actions?: Notification["actions"];
    groupKey?: string;
  }): Promise<Notification | null> {
    this.load();

    const priority = params.priority ?? "normal";
    const category = params.category ?? "message";

    // Check if notification should be suppressed
    if (!this.shouldDeliver(priority, category)) {
      return null;
    }

    const notification: Notification = {
      id: crypto.randomUUID(),
      title: params.title,
      body: params.body,
      priority,
      category,
      channel: params.channel,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      createdAt: Date.now(),
      read: false,
      actions: params.actions,
      groupKey: params.groupKey ?? this.resolveGroupKey(params),
    };

    this.notifications.push(notification);
    this.pruneOldNotifications();
    await this.save();

    // Dispatch to listeners
    for (const listener of this.listeners) {
      try {
        await listener.onNotification(notification);
      } catch {
        // don't let listener errors break the flow
      }
    }

    return notification;
  }

  /** Mark a notification as read. */
  async markRead(id: string): Promise<boolean> {
    this.load();
    const notification = this.notifications.find((n) => n.id === id);
    if (!notification) return false;
    notification.read = true;
    await this.save();
    return true;
  }

  /** Mark all notifications as read. */
  async markAllRead(): Promise<number> {
    this.load();
    let count = 0;
    for (const n of this.notifications) {
      if (!n.read) {
        n.read = true;
        count++;
      }
    }
    if (count > 0) await this.save();
    return count;
  }

  /** Get unread notifications. */
  getUnread(): Notification[] {
    this.load();
    return this.notifications.filter((n) => !n.read);
  }

  /** Get all notifications (optionally filtered). */
  getAll(opts?: {
    category?: NotificationCategory;
    channel?: string;
    agentId?: string;
    limit?: number;
  }): Notification[] {
    this.load();
    let result = [...this.notifications];

    if (opts?.category) {
      result = result.filter((n) => n.category === opts.category);
    }
    if (opts?.channel) {
      result = result.filter((n) => n.channel === opts.channel);
    }
    if (opts?.agentId) {
      result = result.filter((n) => n.agentId === opts.agentId);
    }

    // Sort by creation time, newest first
    result.sort((a, b) => b.createdAt - a.createdAt);

    if (opts?.limit) {
      result = result.slice(0, opts.limit);
    }

    return result;
  }

  /** Get grouped notifications. */
  getGrouped(): Map<string, Notification[]> {
    this.load();
    const groups = new Map<string, Notification[]>();
    for (const n of this.getUnread()) {
      const key = n.groupKey ?? "ungrouped";
      const group = groups.get(key) ?? [];
      group.push(n);
      groups.set(key, group);
    }
    return groups;
  }

  /** Get current preferences. */
  getPreferences(): NotificationPreferences {
    this.load();
    return { ...this.preferences };
  }

  /** Update preferences. */
  async updatePreferences(patch: Partial<NotificationPreferences>): Promise<void> {
    this.load();
    this.preferences = { ...this.preferences, ...patch };
    const prefsPath = path.join(this.stateDir, PREFS_FILENAME);
    await fs.promises.mkdir(path.dirname(prefsPath), { recursive: true });
    await fs.promises.writeFile(prefsPath, JSON.stringify(this.preferences, null, 2), "utf-8");
  }

  /** Clear all notifications. */
  async clear(): Promise<number> {
    this.load();
    const count = this.notifications.length;
    this.notifications = [];
    await this.save();
    return count;
  }

  // ── Private ──

  private shouldDeliver(priority: NotificationPriority, category: NotificationCategory): boolean {
    if (!this.preferences.enabled) return false;

    // Check priority threshold
    if (PRIORITY_ORDER[priority] < PRIORITY_ORDER[this.preferences.minPriority]) {
      return false;
    }

    // Check category filter
    if (this.preferences.categories && this.preferences.categories.length > 0) {
      if (!this.preferences.categories.includes(category)) return false;
    }

    // Check quiet hours (urgent bypasses)
    if (priority !== "urgent" && this.isInQuietHours()) {
      return false;
    }

    return true;
  }

  private isInQuietHours(): boolean {
    const qh = this.preferences.quietHours;
    if (!qh?.enabled) return false;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = qh.start.split(":").map(Number);
    const [endH, endM] = qh.end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // Same day range (e.g. 09:00 - 17:00)
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    // Overnight range (e.g. 22:00 - 08:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  private resolveGroupKey(params: {
    channel?: string;
    agentId?: string;
    category?: string;
  }): string {
    const groupBy = this.preferences.groupBy ?? "channel";
    if (groupBy === "channel") return params.channel ?? "unknown";
    if (groupBy === "agent") return params.agentId ?? "unknown";
    return params.category ?? "message";
  }

  private pruneOldNotifications(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    this.notifications = this.notifications
      .filter((n) => n.createdAt > cutoff)
      .slice(-MAX_STORED_NOTIFICATIONS);
  }

  private async save(): Promise<void> {
    const notifPath = path.join(this.stateDir, NOTIFICATIONS_FILENAME);
    await fs.promises.mkdir(path.dirname(notifPath), { recursive: true });
    await fs.promises.writeFile(notifPath, JSON.stringify(this.notifications, null, 2), "utf-8");
  }
}

// Singleton for the default state dir
let defaultManager: NotificationManager | null = null;

export function getNotificationManager(): NotificationManager {
  if (!defaultManager) {
    defaultManager = new NotificationManager();
  }
  return defaultManager;
}

/** Reset the singleton (for tests). */
export function resetNotificationManager(): void {
  defaultManager = null;
}
