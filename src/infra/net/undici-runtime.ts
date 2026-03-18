import { createRequire } from "node:module";
import type * as UndiciTypes from "undici";

const require = createRequire(import.meta.url);
const undici = require("undici") as typeof import("undici");

export const Agent = undici.Agent;
export const EnvHttpProxyAgent = undici.EnvHttpProxyAgent;
export const ProxyAgent = undici.ProxyAgent;
export const fetch = undici.fetch;
export const getGlobalDispatcher = undici.getGlobalDispatcher;
export const setGlobalDispatcher = undici.setGlobalDispatcher;

export type Agent = UndiciTypes.Agent;
export type Dispatcher = UndiciTypes.Dispatcher;
export type EnvHttpProxyAgent = UndiciTypes.EnvHttpProxyAgent;
export type ProxyAgent = UndiciTypes.ProxyAgent;
export type RequestInit = UndiciTypes.RequestInit;
