// Compile the isolated timezone fixture with its SQLite workers before the child deadline starts.
export const transcriptLibraryTimezoneEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "library-timezone-child.test-support",
  distWorkerPath: "transcripts/library-timezone-child.test-support.js",
} as const;
