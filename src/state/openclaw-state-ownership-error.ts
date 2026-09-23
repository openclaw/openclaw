// Worker error transport needs these identities without opening the ownership
// runtime or importing its filesystem logging dependencies.
export class OpenClawStateOwnershipError extends Error {}

export class OpenClawStateOwnershipMetadataError extends OpenClawStateOwnershipError {
  constructor(
    readonly databasePath: string,
    message: string,
  ) {
    super(
      `OpenClaw shared state ownership metadata is invalid at ${databasePath}: ${message}. ` +
        "Repair it with OPENCLAW_SUPERVISOR_MODE=external openclaw database ownership claim --manager <manager-id>.",
    );
    this.name = "OpenClawStateOwnershipMetadataError";
  }
}

export class OpenClawStateExternalOwnershipError extends OpenClawStateOwnershipError {
  constructor(
    readonly databasePath: string,
    readonly managerId: string,
  ) {
    super(
      `OpenClaw shared state database ${databasePath} is externally supervised by ${managerId}. ` +
        "Use that external supervisor with OPENCLAW_SUPERVISOR_MODE=external for writable operations.",
    );
    this.name = "OpenClawStateExternalOwnershipError";
  }
}
