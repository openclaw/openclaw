import {
  SECRET_STORE_VALUE_MAX_BYTES,
  SecretStoreValidationError,
} from "./secret-store-validation-error.js";
import type { SecretStoreKind } from "./secret-store.types.js";

export function assertSecretStoreValueLength(value: string, kind: SecretStoreKind): void {
  if (Buffer.byteLength(value, "utf8") > SECRET_STORE_VALUE_MAX_BYTES) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_TOO_LARGE",
      `Secret store value exceeds ${SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  // Empty env values are valid; an empty protected credential only fails downstream.
  if (kind === "secret" && value.length === 0) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_EMPTY",
      "Secret store value is empty. Secret entries require a value; check the command that produced it.",
    );
  }
}
