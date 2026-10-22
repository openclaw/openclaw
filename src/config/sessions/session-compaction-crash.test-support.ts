import { bindSqliteWorkerBackend as bindMetadata } from "../../agents/sessions/session-manager-metadata.worker.js";

export function bindSqliteWorkerBackend(
  input: Parameters<typeof bindMetadata>[0],
  context: Parameters<typeof bindMetadata>[1],
) {
  return bindMetadata(input, {
    ...context,
    admit(stage, restriction) {
      if (stage === "commit") {
        // Exit inside the real transaction after transcript and accounting writes, before COMMIT.
        process.exit(92);
      }
      context.admit(stage, restriction);
    },
  });
}
