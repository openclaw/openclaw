export const REMOTE_WINDOWS_ACQUIRE_WORKSPACE_LEASE_JS = String.raw`function acquireWindowsWorkspaceLease(nonce, watchdogTimeoutMs) {
  withWindowsWorkspaceLease(windowsLeaseDatabasePath, workspaceKey, (raw) => {
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (!/^[a-f0-9]{32}$/.test(parsed?.nonce || "")) {
        throw new Error("invalid Windows shared-host workspace quiescence lease");
      }
      const candidate = parseWindowsLease(raw, parsed.nonce);
      if (candidate.expiresAtMs > Date.now()) {
        throw new Error("workspace quiescence lease is already active");
      }
    }
    const lease = {
      version: 1,
      nonce,
      sharedHost: true,
      processes: [],
      watchdog: null,
      expiresAtMs: Date.now() + watchdogTimeoutMs,
    };
    return JSON.stringify(lease);
  });
  process.stderr.write("workspace quiescence: Windows shared host declared; using manifest fences without process freezing\n");
}`;

export function windowsWorkspaceQuiescenceScript(context: string, lease: string): string {
  return String.raw`(() => {
${context}
fs.mkdirSync(leaseDirectory, { recursive: true });
const nonce = crypto.randomBytes(16).toString("hex");
let watchdogTimeoutMs = Number(process.argv[2] || 12 * 60 * 1000);
if (!Number.isSafeInteger(watchdogTimeoutMs) || watchdogTimeoutMs < 1) throw new Error("invalid watchdog timeout");
if ((process.argv[3] || "dedicated") !== "shared-host") throw new Error("workspace quiescence requires POSIX");
${lease}
${REMOTE_WINDOWS_ACQUIRE_WORKSPACE_LEASE_JS}
acquireWindowsWorkspaceLease(nonce, watchdogTimeoutMs);
process.stdout.write("quiesced " + nonce + "\n");
})();
`;
}
