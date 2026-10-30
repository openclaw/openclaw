import fs from "node:fs/promises";
import { password } from "@clack/prompts";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import { parseSecretStoreDotEnvText } from "../secrets/store/dotenv.js";
import {
  SECRET_STORE_VALUE_MAX_BYTES,
  SecretStoreValidationError,
} from "../secrets/store/secret-store.js";
import { SecretStoreInputFileError } from "./secrets-store-input-error.js";

const SECRET_STORE_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

async function readBoundedStdin(maxBytes: number): Promise<string> {
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes,
    // Oversized input is the same validation failure as an oversized stored value,
    // so it must carry the typed code the CLI maps to exit 2 on every input path.
    onOverflow: ({ maxBytes: limit }) =>
      new SecretStoreValidationError(
        "SECRET_STORE_VALUE_TOO_LARGE",
        `Stdin input exceeds ${limit} bytes.`,
      ),
  });
  return decodeUtf8Input(bytes, "Stdin input");
}

function readFailureErrorCode(error: unknown): string | undefined {
  // SAFETY: invariant — fs error objects expose a string `code` via the narrowed object read.
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : undefined;
}

function describeInputFileOpenFailure(pathname: string, error: unknown): string {
  const code = readFailureErrorCode(error);
  // Keep missing paths (ENOENT/ENOTDIR) and denied access (EACCES) distinguishable
  // while pointing the operator at the corrective action.
  return `Input file could not be read${code ? ` (${code})` : ""}: ${pathname}. Check that the path exists and is readable.`;
}

async function readBoundedFile(pathname: string, maxBytes: number): Promise<string> {
  // Open FIFOs without waiting for a writer so the descriptor check can reject them.
  const flags =
    process.platform === "win32" ? "r" : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  let file: fs.FileHandle;
  try {
    file = await fs.open(pathname, flags);
  } catch (error) {
    throw new SecretStoreInputFileError(describeInputFileOpenFailure(pathname, error), {
      cause: error,
    });
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new SecretStoreInputFileError(`Input path is not a regular file: ${pathname}`);
    }
    if (stat.size > maxBytes) {
      throw new SecretStoreValidationError(
        "SECRET_STORE_VALUE_TOO_LARGE",
        `Input file exceeds ${maxBytes} bytes: ${pathname}`,
      );
    }
    return decodeUtf8Input(await readFileDescriptorBounded(file.fd, maxBytes), "Input file");
  } finally {
    await file.close();
  }
}

export async function readSecretStoreInput(valueFile?: string): Promise<string> {
  if (valueFile && valueFile !== "-") {
    return await readBoundedFile(valueFile, SECRET_STORE_VALUE_MAX_BYTES);
  }
  if (valueFile === "-" || !process.stdin.isTTY) {
    return (await readBoundedStdin(SECRET_STORE_VALUE_MAX_BYTES)).replace(/\r?\n$/u, "");
  }
  const value = await password({
    message: "Secret value",
    // Empty masking prevents shoulder-surfing length disclosure as well as terminal echo.
    mask: "",
    validate: (candidate) =>
      Buffer.byteLength(candidate ?? "", "utf8") <= SECRET_STORE_VALUE_MAX_BYTES
        ? undefined
        : `Value exceeds ${SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
  });
  if (typeof value === "symbol") {
    throw new Error("Secret input cancelled.");
  }
  return value;
}

export async function readSecretStoreImport(from?: string): Promise<Record<string, string>> {
  const raw =
    from && from !== "-"
      ? await readBoundedFile(from, SECRET_STORE_IMPORT_MAX_BYTES)
      : await readBoundedStdin(SECRET_STORE_IMPORT_MAX_BYTES);
  return parseSecretStoreDotEnvText(raw);
}
