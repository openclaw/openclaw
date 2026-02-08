export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);

  if (seconds < 0) {
    const futureSeconds = Math.abs(seconds);
    const futureMinutes = Math.floor(futureSeconds / 60);
    const futureHours = Math.floor(futureMinutes / 60);
    const futureDays = Math.floor(futureHours / 24);

    if (futureSeconds < 60) {
      return "in a moment";
    }
    if (futureMinutes < 60) {
      return `in ${futureMinutes}m`;
    }
    if (futureHours < 24) {
      return `in ${futureHours}h`;
    }
    if (futureDays === 1) {
      return "Tomorrow";
    }
    if (futureDays < 7) {
      return `in ${futureDays}d`;
    }
    return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
