import os from "node:os";

// Set HOSTNAME env var before any tslog imports.
// tslog reads hostname at module load time via os.hostname() or env vars,
// and macOS intermittently returns empty string during ESM module resolution.
// Setting env ensures tslog's _meta.hostname is correct.
if (!process.env.HOSTNAME && !process.env.HOST && !process.env.COMPUTERNAME) {
  const hostname = os.hostname();
  if (hostname) {
    process.env.HOSTNAME = hostname;
  }
}
