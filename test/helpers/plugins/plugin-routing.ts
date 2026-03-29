export {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "../../../src/infra/outbound/session-binding-service.js";
export { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
export { resolveAgentRoute } from "../../../src/routing/resolve-route.js";
export { createTestRegistry } from "../../../src/test-utils/channel-plugins.js";
