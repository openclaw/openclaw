import { trackAsyncWork } from "../shared/async-work-scope.js";

export function createParentTranscriptWriteContext() {
  return {
    sessionTarget: {
      agentId: "main",
      sessionId: "parent-session",
      sessionKey: "agent:main:parent",
      storePath: "/tmp/transcript-writer-parent.sqlite",
      expectedWriterRunId: "parent-run",
    },
    withTranscriptWrite: trackAsyncWork,
  };
}
