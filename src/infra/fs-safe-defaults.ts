// Preserve fs-safe's auto default for atomic no-clobber moves and Windows ACL checks.
// Explicit operator modes and sealed-worker configuration remain library-owned.
export { configureFsSafeNative } from "@openclaw/fs-safe/config";
