import type { ApnsRegistration } from "./push-apns-store.types.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

export type ApnsRegistrationWorkerOperations = {
  "apns.registration.register": {
    input: { candidate: ApnsRegistration; expectedPairingGeneration?: string; nowMs: number };
    output:
      | { status: "pairing-changed" }
      | { status: "registered"; registration: ApnsRegistration };
  };
  "apns.registration.read": { input: string; output: ApnsRegistration | null };
  "apns.registrations.read": { input: readonly string[]; output: Map<string, ApnsRegistration> };
};

export function isApnsRegistrationWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<ApnsRegistrationWorkerOperations> {
  return (
    command.type === "apns.registration.register" ||
    command.type === "apns.registration.read" ||
    command.type === "apns.registrations.read"
  );
}
