import type { AuthorizationPolicyRegistration } from "./authorization-policy.types.js";
// Builds plugin API facades exposed to bundled and external plugins.
import type { OpenClawPluginApi } from "./types.js";

export const registerAuthorizationPolicySymbol = Symbol("registerAuthorizationPolicy");

export type AuthorizationPolicyRegistrar = (policy: AuthorizationPolicyRegistration) => void;

type PluginApiAuthorizationRegistrar = {
  [registerAuthorizationPolicySymbol]: AuthorizationPolicyRegistrar;
};

/** Host-only API shape carrying registration plumbing hidden from plugins. */
export type HostOpenClawPluginApi = OpenClawPluginApi & PluginApiAuthorizationRegistrar;

type PluginApiFacadeFields = Pick<
  OpenClawPluginApi,
  "agent" | "authorization" | "lifecycle" | "runContext" | "session"
>;
/** Plugin API shape without nested facade namespaces attached. */
export type OpenClawPluginApiWithoutFacades = Omit<OpenClawPluginApi, keyof PluginApiFacadeFields> &
  PluginApiAuthorizationRegistrar;
type PluginApiFacadeSource = Pick<
  OpenClawPluginApi,
  | "clearRunContext"
  | "emitAgentEvent"
  | "enqueueNextTurnInjection"
  | "getRunContext"
  | "registerAgentEventSubscription"
  | "registerControlUiDescriptor"
  | "registerRuntimeLifecycle"
  | "registerSessionAction"
  | "registerSessionExtension"
  | "registerSessionSchedulerJob"
  | "scheduleSessionTurn"
  | "sendSessionAttachment"
  | "setRunContext"
  | "unscheduleSessionTurnsByTag"
> &
  PluginApiAuthorizationRegistrar;

/** Attaches nested facade namespaces to the flat plugin API implementation. */
export function attachPluginApiFacades<T extends object>(
  api: T & PluginApiFacadeSource & Partial<PluginApiFacadeFields>,
): T & PluginApiFacadeFields {
  api.session = {
    state: {
      registerSessionExtension: (...args) => api.registerSessionExtension(...args),
    },
    workflow: {
      enqueueNextTurnInjection: (...args) => api.enqueueNextTurnInjection(...args),
      registerSessionSchedulerJob: (...args) => api.registerSessionSchedulerJob(...args),
      sendSessionAttachment: (...args) => api.sendSessionAttachment(...args),
      scheduleSessionTurn: (...args) => api.scheduleSessionTurn(...args),
      unscheduleSessionTurnsByTag: (...args) => api.unscheduleSessionTurnsByTag(...args),
    },
    controls: {
      registerSessionAction: (...args) => api.registerSessionAction(...args),
      registerControlUiDescriptor: (...args) => api.registerControlUiDescriptor(...args),
    },
  };
  api.agent = {
    events: {
      registerAgentEventSubscription: (...args) => api.registerAgentEventSubscription(...args),
      emitAgentEvent: (...args) => api.emitAgentEvent(...args),
    },
  };
  api.runContext = {
    setRunContext: (...args) => api.setRunContext(...args),
    getRunContext: (...args) => api.getRunContext(...args),
    clearRunContext: (...args) => api.clearRunContext(...args),
  };
  api.lifecycle = {
    registerRuntimeLifecycle: (...args) => api.registerRuntimeLifecycle(...args),
  };
  api.authorization = {
    registerPolicy: (...args) => api[registerAuthorizationPolicySymbol](...args),
  };
  return api as T & PluginApiFacadeFields;
}
