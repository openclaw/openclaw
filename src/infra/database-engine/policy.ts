// Connection setup gets 60s of headroom below PostgresSyncConnection.request's 120s deadline.
export const POSTGRES_CONNECT_TIMEOUT_MS = 60_000;
// Keep lock waits below the sync bridge deadline while allowing slow storage and migrations.
export const POSTGRES_LOCK_TIMEOUT_MS = 60_000;
export const POSTGRES_STATEMENT_TIMEOUT_MS = 90_000;
