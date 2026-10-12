import type { SessionActorOperations } from "../config/sessions/session-actor-contract.js";
import type { IncognitoSessionOperations } from "../config/sessions/session-incognito-contract.js";

/** Legacy facts replies and actor receipts retain their distinct wire contracts. */
export type IncognitoAgentDatabaseOperations = IncognitoSessionOperations & SessionActorOperations;
