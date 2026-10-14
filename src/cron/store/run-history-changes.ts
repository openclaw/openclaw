import { BroadcastChannel } from "node:worker_threads";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { readTrackedStateDatabaseIdentity } from "../../state/openclaw-state-db-handle.js";

const channelName = `openclaw.cron.history.${process.pid}`;

/** History writers notify retention only after their owning transaction commits. */
export function publishCronRunHistoryChange(database: EngineConnection): void {
  const publish = () => {
    const channel = new BroadcastChannel(channelName);
    try {
      const notify = channel.postMessage.bind(channel);
      notify(readTrackedStateDatabaseIdentity(sqlPublicationAnchor(database))?.canonicalPath);
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
