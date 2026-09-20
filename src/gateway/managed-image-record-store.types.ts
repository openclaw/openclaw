import type { Insertable, Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

type ManagedImageRecordVariant = {
  mediaRoot: string;
  mediaId: string;
  mediaSubdir: string;
  contentType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  filename: string | null;
};

type ManagedImageRetentionClass = "transient" | "history";

export type ManagedImageRecord = {
  attachmentId: string;
  sessionKey: string;
  agentId?: string;
  messageId: string | null;
  createdAt: string;
  updatedAt?: string;
  retentionClass?: ManagedImageRetentionClass;
  alt: string;
  original: ManagedImageRecordVariant;
};

export type ManagedImageRecordDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "managed_outgoing_image_records"
>;
export type ManagedImageRecordRow = Omit<
  Selectable<ManagedImageRecordDatabase["managed_outgoing_image_records"]>,
  "record_json"
>;
export type ManagedImageRecordInsert = Insertable<
  ManagedImageRecordDatabase["managed_outgoing_image_records"]
>;
export type ManagedImageRecordEntry = {
  record: ManagedImageRecord;
  cleanupPending: boolean;
};
