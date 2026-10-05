import type { startGatewayServer } from "../../gateway/server.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { RuntimeEnv } from "../../runtime.js";
import type {
  GatewayRunLoopStartOptions,
  GatewayRestartStartupFailureHandler,
} from "./run-loop-startup.js";

export type GatewayRunLoopOptions = {
  start: (
    params?: GatewayRunLoopStartOptions,
  ) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: RuntimeEnv;
  /** Grants this run loop authority over the process it exclusively owns. */
  ownsProcessLifecycle?: boolean;
  lockPort?: number;
  lifecycleLockDeadlineMs?: number;
  healthHost?: string;
  beginBoot?: (startedAtMs: number) => void | Promise<void>;
  completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
  onRestartStartupFailure?: GatewayRestartStartupFailureHandler;
};
