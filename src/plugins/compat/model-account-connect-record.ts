import type { PluginCompatRecord } from "./types.js";

export const MODEL_ACCOUNT_CONNECT_COMPAT_RECORD = {
  code: "model-account-connect-sync-persistence",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-03",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await modelAccountConnectService.listLinksAsync, linkAsync, unlinkAsync, listAsync, selectAsync, statusAsync, and cancelAsync with the existing arguments. Retain synchronous methods and their completion timing for shipped third-party contracts until the next Plugin SDK major and explicit breaking-release approval.",
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
  tests: [
    "src/plugins/compat/registry.test.ts",
    "src/plugins/compat/model-account-connect-deprecation.test.ts",
    "src/plugin-sdk/gateway-model-account-connect-compat.test.ts",
    "src/gateway/server-methods/users-auth-connect.test.ts",
  ],
  releaseNote:
    "Personal model-account control-plane operations expose awaited worker-backed methods. Synchronous plugin methods retain their existing arguments, return values, and completion timing until the next Plugin SDK major; RPC envelopes, stored data, retention, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
