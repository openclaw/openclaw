export const ARCHIVE_RETENTION_BATCH_SIZE = 256;

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

export type SessionArchivePruningRead = {
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  expectedIdentity: { physicalIdentity: string; nativeLocation: string };
  limit?: number;
};

export type SessionArchiveRetentionDelete = {
  candidates: readonly PublishedSessionTranscriptArchive[];
  archiveDirectory: string;
};

export type SessionArchivePruningOperations = {
  withWriter: <T>(run: () => Promise<T>) => Promise<T>;
  read: () => Promise<PublishedSessionTranscriptArchive | null>;
  readRetentionCandidates: () => Promise<PublishedSessionTranscriptArchive[]>;
  pruneRetention: (input: SessionArchiveRetentionDelete) => Promise<number>;
  removeLegacy: (filePath: string) => Promise<SessionLegacyArchiveRemovalResult>;
  deletePublished: (archive: PublishedSessionTranscriptArchive) => Promise<void>;
};
