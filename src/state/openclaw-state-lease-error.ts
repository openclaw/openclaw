const leaseErrorCodes = [
  "OPENCLAW_STATE_LEASE_INVALID_INPUT",
  "OPENCLAW_STATE_LEASE_TIMEOUT",
  "OPENCLAW_STATE_LEASE_ABORTED",
  "OPENCLAW_STATE_LEASE_LOST",
  "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
] as const;
export type OpenClawStateLeaseErrorCode = (typeof leaseErrorCodes)[number];

export function isOpenClawStateLeaseErrorCode(
  value: unknown,
): value is OpenClawStateLeaseErrorCode {
  return leaseErrorCodes.some((code) => code === value);
}

export class OpenClawStateLeaseError extends Error {
  readonly code: OpenClawStateLeaseErrorCode;

  constructor(message: string, options: { code: OpenClawStateLeaseErrorCode; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "OpenClawStateLeaseError";
    this.code = options.code;
  }
}

export function toOpenClawStateLeaseVerificationError(
  identity: { scope: string; key: string; leaseLabel?: string },
  error: unknown,
): OpenClawStateLeaseError {
  return error instanceof OpenClawStateLeaseError
    ? error
    : new OpenClawStateLeaseError(
        `failed to verify ${identity.leaseLabel ?? "state lease"} ${identity.scope}/${identity.key}`,
        { code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED", cause: error },
      );
}
