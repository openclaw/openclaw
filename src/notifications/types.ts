export type NotificationPriority = "low" | "normal" | "high" | "urgent";

export type NotificationCategory =
  | "message"
  | "agent-complete"
  | "tool-approval"
  | "error"
  | "system";

export type Notification = {
  id: string;
  /** Notification title (short summary). */
  title: string;
  /** Notification body (detail text). */
  body: string;
  /** Priority for routing (urgent bypasses DND). */
  priority: NotificationPriority;
  /** Category for grouping. */
  category: NotificationCategory;
  /** Source channel that triggered this notification. */
  channel?: string;
  /** Agent id that generated this notification. */
  agentId?: string;
  /** Session key for context. */
  sessionKey?: string;
  /** Timestamp when notification was created. */
  createdAt: number;
  /** Whether the notification has been read/dismissed. */
  read: boolean;
  /** Actionable quick-reply options. */
  actions?: NotificationAction[];
  /** Grouping key for smart notification batching. */
  groupKey?: string;
};

export type NotificationAction = {
  id: string;
  label: string;
  /** Action type: reply sends text back, approve accepts tool execution, dismiss clears. */
  type: "reply" | "approve" | "dismiss" | "snooze";
  /** Pre-filled reply text (for reply actions). */
  payload?: string;
};

export type NotificationPreferences = {
  /** Global enable/disable for notifications. */
  enabled: boolean;
  /** Priority threshold: only deliver notifications at or above this level. */
  minPriority: NotificationPriority;
  /** Categories to deliver (empty = all). */
  categories?: NotificationCategory[];
  /** Quiet hours: suppress non-urgent notifications. */
  quietHours?: {
    enabled: boolean;
    start: string; // "22:00"
    end: string; // "08:00"
    timezone?: string;
  };
  /** Group notifications by this key (default: "channel"). */
  groupBy?: "channel" | "agent" | "category";
};

export type NotificationListener = {
  onNotification: (notification: Notification) => void | Promise<void>;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  minPriority: "normal",
  groupBy: "channel",
};

export const PRIORITY_ORDER: Record<NotificationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};
