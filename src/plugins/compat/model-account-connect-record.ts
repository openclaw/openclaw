import type { PluginCompatRecord } from "./types.js";

export const MODEL_ACCOUNT_CONNECT_COMPAT_RECORD = {
  code: "model-account-connect-sync-persistence",
  status: "deprecated",
  owner: "sdk",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removeAfter: "2026-12-31",
  replacement:
    "Await modelAccountConnectService.listLinksAsync, linkAsync, unlinkAsync, listAsync, selectAsync, statusAsync, and cancelAsync with the existing arguments. Retain synchronous methods and their completion timing for shipped third-party contracts through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-personal-model-account-operations",
  surfaces: [
    "GatewayRequestHandlerOptions.context.modelAccountConnectService.listLinks",
    "GatewayRequestHandlerOptions.context.modelAccountConnectService.link",
    "GatewayRequestHandlerOptions.context.modelAccountConnectService.unlink",
    "GatewayRequestHandlerOptions.context.modelAccountConnectService.list",
    "GatewayRequestHandlerOptions.context.modelAccountConnectService.select",
    "GatewayRequestHandlerOptions.context.modelAccountConnectService.status",
    "GatewayRequestHandlerOptions.context.modelAccountConnectService.cancel",
    "getPluginRuntimeGatewayRequestScope().context.modelAccountConnectService",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations and one DEP_SESSION_PERSISTENCE warning per plugin and capability family per process; unscoped callers share one SDK-level family warning",
  ],
} as const satisfies PluginCompatRecord;
