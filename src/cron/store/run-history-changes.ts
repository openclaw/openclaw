import type { DatabaseSync } from "node:sqlite";
import { BroadcastChannel } from "node:worker_threads";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";

const channelName = `openclaw.cron.history.${process.pid}`;

/** History writers notify retention only after their owning transaction commits. */
export function publishCronRunHistoryChange(database: DatabaseSync): void {
  const publish = () => {
    const channel = new BroadcastChannel(channelName);
    try {
      const notify = channel.postMessage.bind(channel);
      notify(database.location());
    } finally {
      channel.close();
    }
  };
  if (!deferSqlitePostCommitPublication(database, publish)) {
    publish();
  }
}

export function subscribeCronRunHistoryChanges(
  listener: (databasePath: string) => void,
): () => void {
  const channel = new BroadcastChannel(channelName);
  channel.unref();
  channel.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      listener(event.data);
    }
  });
  return () => channel.close();
}
