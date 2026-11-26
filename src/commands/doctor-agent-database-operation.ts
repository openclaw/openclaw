import { note } from "../../packages/terminal-core/src/note.js";
import { formatErrorMessage } from "../infra/errors.js";
import { shortenHomePath } from "../utils.js";

type DoctorAgentDatabaseOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/** Keep one unusable agent database from aborting sibling Doctor work. */
export function runDoctorAgentDatabaseOperation<T>(params: {
  agentId: string;
  path: string;
  run: () => T;
}): DoctorAgentDatabaseOperationResult<T> {
  try {
    return { ok: true, value: params.run() };
  } catch (error) {
    return { ok: false, message: noteDoctorAgentDatabaseFailure(params, error) };
  }
}

export async function runDoctorAgentDatabaseOperationAsync<T>(params: {
  agentId: string;
  path: string;
  run: () => Promise<T>;
}): Promise<DoctorAgentDatabaseOperationResult<T>> {
  try {
    return { ok: true, value: await params.run() };
  } catch (error) {
    return { ok: false, message: noteDoctorAgentDatabaseFailure(params, error) };
  }
}

function noteDoctorAgentDatabaseFailure(
  params: { agentId: string; path: string },
  error: unknown,
): string {
  const message = `Agent ${params.agentId} database ${shortenHomePath(params.path)}: ${formatErrorMessage(error)}`;
  note(`- ${message}`, "Doctor warnings");
  return message;
}
