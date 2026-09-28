import type { Selectable } from "kysely";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

export type SqliteSessionGenerationWindow = Selectable<DB["session_windows"]>;

export type SqliteSessionGenerationClaim = {
  window: SqliteSessionGenerationWindow;
  coldArchive: Omit<Selectable<DB["session_transcript_cold_archives"]>, "archive_blob"> | undefined;
  fingerprint: string;
  contentFingerprint: string;
};
