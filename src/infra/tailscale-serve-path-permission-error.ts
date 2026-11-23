/** A Serve command failed with 401 because the existing config contains a path/socket handler requiring root. */
export class TailscaleServePathPermissionError extends Error {
  constructor(detail?: string) {
    super(
      detail?.trim() ||
        "401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket",
    );
    this.name = "TailscaleServePathPermissionError";
  }
}

export function isTailscaleServePathPermissionMessage(output: string): boolean {
  return (
    /401\s+Unauthorized/i.test(output) && /must be root|serve a path or Unix socket/i.test(output)
  );
}
