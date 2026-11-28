export type DeferredSessionTranscriptReadOperations = {
  "deferredSessionImport.verifyMissingTranscript": {
    input: {
      sessionId: string;
      identity: { size: number; sha256: string };
    };
    output: boolean;
  };
};
