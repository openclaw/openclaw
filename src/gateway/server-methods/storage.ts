import {
  type StorageLocationsListResult,
  type StorageLocationsProbeResult,
  validateStorageLocationsListParams,
  validateStorageLocationsProbeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getLoadedRuntimePluginRegistry } from "../../plugins/active-runtime-registry.js";
import { listStorageLocations, probeStorageLocation } from "../../storage/locations.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const storageHandlers: GatewayRequestHandlers = {
  "storage.locations.list": defineValidatedGatewayMethod(
    "storage.locations.list",
    validateStorageLocationsListParams,
    ({ context, respond }) => {
      const result: StorageLocationsListResult = {
        locations: listStorageLocations(
          context.getRuntimeConfig(),
          getLoadedRuntimePluginRegistry() ?? undefined,
        ),
      };
      respond(true, result, undefined);
    },
  ),
  "storage.locations.probe": defineValidatedGatewayMethod(
    "storage.locations.probe",
    validateStorageLocationsProbeParams,
    async ({ params, context, respond }) => {
      const result: StorageLocationsProbeResult = await probeStorageLocation({
        name: params.name,
        config: context.getRuntimeConfig(),
        registry: getLoadedRuntimePluginRegistry() ?? { storageProviders: new Map() },
      });
      respond(true, result, undefined);
    },
  ),
};
