// Dynamic-import boundary for ops.ts.
// src/cron/service.ts statically imports ops.ts; timer.ts needs lazy access
// to break the circular dep (ops → timer → ops). Importing this boundary
// instead of ops.ts directly keeps ops.ts in the static import graph only
// and prevents the bundler from emitting two separate module instances.
// See CLAUDE.md: "Dynamic import guardrail".
export { run } from "./ops.js";
