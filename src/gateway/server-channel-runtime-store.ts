import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { PluginHttpRouteHandoff } from "../plugins/http-registry.js";
import type {
  ChannelAccountLifetime,
  ChannelAccountStopState,
} from "./server-channel-runtime.types.js";
import type { ChannelStartFence } from "./server-channel-start-fence.js";

// This private manager state depends on implementation owners. Keep it out of
// the snapshot contracts consumed by Gateway request and plugin runtime types.
export type ChannelRuntimeStore = {
  startFence?: ChannelStartFence;
  lifetimes: Map<string, ChannelAccountLifetime>;
  routeHandoffs: Map<string, PluginHttpRouteHandoff>;
  starting: Map<string, Promise<void>>;
  stops: Map<string, ChannelAccountStopState>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};
