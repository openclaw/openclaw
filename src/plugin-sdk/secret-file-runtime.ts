/**
 * Runtime SDK subpath for private secret file reads and atomic writes.
 */
export {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  loadSecretFileSync,
  readSecretFileSync,
  tryReadSecretFileSync,
} from "../infra/secret-file.js";
export type { SecretFileReadResult } from "../infra/secret-file.js";
