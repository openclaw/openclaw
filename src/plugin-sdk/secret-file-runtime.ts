export {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  readSecretFileSync,
  writePrivateSecretFileAtomic,
  tryReadSecretFileSync,
} from "../infra/secret-file.js";
export type { SecretFileReadOptions } from "../infra/secret-file.js";
