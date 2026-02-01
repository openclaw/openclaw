import { Writable } from "node:stream";
import type { GatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";

export type DaemonAction = "install" | "uninstall" | "start" | "stop" | "restart";

export type DaemonActionResponse = {
  ok: boolean;
  action: DaemonAction;
  result?: string;
  message?: string;
  error?: string;
  hints?: string[];
  warnings?: string[];
  service?: {
    label: string;
    loaded: boolean;
    loadedText: string;
    notLoadedText: string;
  };
};

export function emitDaemonActionJson(payload: DaemonActionResponse) {
  defaultRuntime.log(JSON.stringify(payload, null, 2));
}

export function buildDaemonServiceSnapshot(service: GatewayService, loaded: boolean) {
  return {
    label: service.label,
    loaded,
    loadedText: service.loadedText,
    notLoadedText: service.notLoadedText,
  };
}

export function createNullWriter(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
