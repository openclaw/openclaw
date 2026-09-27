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

export type ManagedImageRecordAttachment = {
  attachmentId: string;
  sessionKey: string;
  messageId: string;
  updatedAt: string;
};

export type ManagedImageRecordWorkerOperations = {
  "managedImages.insert": { input: ManagedImageRecord; output: boolean };
  "managedImages.attach": { input: ManagedImageRecordAttachment; output: boolean };
  "managedImages.claimCleanup": { input: ManagedImageRecord; output: boolean };
  "managedImages.deleteClaimed": { input: ManagedImageRecord; output: boolean };
  "managedImages.read": { input: { attachmentId: string }; output: ManagedImageRecord | null };
  "managedImages.entries": { input: { sessionKey?: string }; output: ManagedImageRecordEntry[] };
  "managedImages.originalMediaIds": { input: undefined; output: string[] };
};

export type ManagedImageRecordCommand = {
  [Key in keyof ManagedImageRecordWorkerOperations]: {
    type: Key;
    input: ManagedImageRecordWorkerOperations[Key]["input"];
  };
}[keyof ManagedImageRecordWorkerOperations];

export type ManagedImageRecordMutation = Extract<
  ManagedImageRecordCommand,
  {
    type:
      | "managedImages.insert"
      | "managedImages.attach"
      | "managedImages.claimCleanup"
      | "managedImages.deleteClaimed";
  }
>;
