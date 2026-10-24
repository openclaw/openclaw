import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

/** Each profile needs the shared database and its matching local credential owner. */
export function initializeExistingUpdateProfile(env: NodeJS.ProcessEnv = process.env): void {
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
}
