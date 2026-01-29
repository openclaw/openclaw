import { getNotificationManager } from "../notifications/manager.js";
import type { NotificationCategory, NotificationPriority } from "../notifications/types.js";
import { info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";

export type NotificationsListOptions = {
  json?: boolean;
  unread?: boolean;
  category?: string;
  channel?: string;
  agent?: string;
  limit?: number;
};

export async function notificationsListCommand(
  opts: NotificationsListOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const manager = getNotificationManager();
  const notifications = opts.unread
    ? manager.getUnread()
    : manager.getAll({
        category: opts.category as NotificationCategory | undefined,
        channel: opts.channel,
        agentId: opts.agent,
        limit: opts.limit,
      });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: notifications.length,
          unreadOnly: opts.unread ?? false,
          notifications,
        },
        null,
        2,
      ),
    );
    return;
  }

  const unread = manager.getUnread().length;
  runtime.log(info(`Notifications: ${notifications.length} total, ${unread} unread`));

  if (notifications.length === 0) {
    runtime.log("No notifications.");
    return;
  }

  const rich = isRich();
  runtime.log("");

  for (const n of notifications) {
    const readMark = n.read ? " " : "*";
    const priorityLabel = n.priority === "urgent" ? " [URGENT]" : n.priority === "high" ? " [HIGH]" : "";
    const ts = new Date(n.createdAt).toLocaleString();
    const channel = n.channel ? ` (${n.channel})` : "";

    if (rich) {
      const titleLine = `${readMark} ${theme.accent(n.title)}${priorityLabel}${channel}`;
      runtime.log(titleLine);
      runtime.log(`  ${theme.muted(ts)} ${theme.muted(`[${n.category}]`)}`);
      runtime.log(`  ${n.body}`);
      if (n.actions?.length) {
        const actionLabels = n.actions.map((a) => `[${a.label}]`).join(" ");
        runtime.log(`  ${theme.info(actionLabels)}`);
      }
    } else {
      runtime.log(`${readMark} ${n.title}${priorityLabel}${channel}`);
      runtime.log(`  ${ts} [${n.category}]`);
      runtime.log(`  ${n.body}`);
    }
    runtime.log("");
  }
}

export async function notificationsReadCommand(
  opts: { id?: string; all?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const manager = getNotificationManager();

  if (opts.all) {
    const count = await manager.markAllRead();
    runtime.log(info(`Marked ${count} notification(s) as read.`));
    return;
  }

  if (opts.id) {
    const ok = await manager.markRead(opts.id);
    if (ok) {
      runtime.log(info(`Notification ${opts.id} marked as read.`));
    } else {
      runtime.error(`Notification "${opts.id}" not found.`);
    }
    return;
  }

  runtime.error("Specify --id <id> or --all to mark notifications as read.");
}

export async function notificationsClearCommand(runtime: RuntimeEnv): Promise<void> {
  const manager = getNotificationManager();
  const count = await manager.clear();
  runtime.log(info(`Cleared ${count} notification(s).`));
}

export async function notificationsPrefsCommand(
  opts: {
    json?: boolean;
    enabled?: string;
    minPriority?: string;
    groupBy?: string;
    quietStart?: string;
    quietEnd?: string;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  const manager = getNotificationManager();

  // If any setter is provided, update preferences
  const hasUpdates =
    opts.enabled !== undefined ||
    opts.minPriority !== undefined ||
    opts.groupBy !== undefined ||
    opts.quietStart !== undefined ||
    opts.quietEnd !== undefined;

  if (hasUpdates) {
    const patch: Record<string, unknown> = {};
    if (opts.enabled !== undefined) {
      patch.enabled = opts.enabled === "true" || opts.enabled === "1";
    }
    if (opts.minPriority !== undefined) {
      patch.minPriority = opts.minPriority as NotificationPriority;
    }
    if (opts.groupBy !== undefined) {
      patch.groupBy = opts.groupBy;
    }
    if (opts.quietStart || opts.quietEnd) {
      const current = manager.getPreferences().quietHours ?? {
        enabled: true,
        start: "22:00",
        end: "08:00",
      };
      patch.quietHours = {
        ...current,
        enabled: true,
        start: opts.quietStart ?? current.start,
        end: opts.quietEnd ?? current.end,
      };
    }
    await manager.updatePreferences(patch);
    runtime.log(info("Notification preferences updated."));
  }

  const prefs = manager.getPreferences();

  if (opts.json) {
    runtime.log(JSON.stringify(prefs, null, 2));
    return;
  }

  const rich = isRich();
  runtime.log(rich ? theme.heading("Notification Preferences") : "Notification Preferences");
  runtime.log(`  Enabled: ${prefs.enabled}`);
  runtime.log(`  Min priority: ${prefs.minPriority}`);
  runtime.log(`  Group by: ${prefs.groupBy ?? "channel"}`);
  if (prefs.quietHours?.enabled) {
    runtime.log(`  Quiet hours: ${prefs.quietHours.start} - ${prefs.quietHours.end}`);
  } else {
    runtime.log("  Quiet hours: disabled");
  }
  if (prefs.categories?.length) {
    runtime.log(`  Categories: ${prefs.categories.join(", ")}`);
  }
}
