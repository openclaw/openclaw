export type PublishedSessionTranscriptArchive = {
  archive_name: string;
  archive_sha256: string;
  created_at: number;
  encoding: string;
  generation: string;
  published_at: number;
  reason: string;
  session_id: string;
  session_key: string;
};

export type SessionLegacyArchiveRemovalResult = "removed" | "failed" | "preserved";

export type SessionArchivePruningOperations = {
  read: () => Promise<PublishedSessionTranscriptArchive | null>;
  removeLegacy: (filePath: string) => Promise<SessionLegacyArchiveRemovalResult>;
  deletePublished: (archive: PublishedSessionTranscriptArchive) => Promise<void>;
};
