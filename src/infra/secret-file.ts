export {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  readSecretFileSync,
  tryReadSecretFileSync,
  type SecretFileReadOptions,
} from "@openclaw/fs-safe/secret";
export { loadSecretFileSync, type SecretFileReadResult } from "@openclaw/fs-safe/advanced";
export { writeSecretFileAtomic as writePrivateSecretFileAtomic } from "@openclaw/fs-safe/secret";
