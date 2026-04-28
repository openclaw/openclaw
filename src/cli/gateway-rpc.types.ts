import type { OperatorScope } from "../gateway/operator-scopes.js";

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
  scopes?: OperatorScope[];
};
