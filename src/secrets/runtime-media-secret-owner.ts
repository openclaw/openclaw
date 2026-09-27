import type {
  MediaUnderstandingCapability,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { tokenizeConcreteConfigPath } from "../shared/dot-path.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "./runtime-degraded-state.js";

/** Runtime owner for one configured media-understanding model entry. */
export function runtimeMediaModelSecretOwnerId(index: number): string {
  return `media-model:shared:${index}`;
}

/** Runtime owner for request defaults inherited by one media capability. */
export function runtimeMediaRequestSecretOwnerId(capability: MediaUnderstandingCapability): string {
  return `media-model:${capability}:request`;
}

function modelRequestOverridesPath(entry: MediaUnderstandingModelConfig, path: string): boolean {
  const request = entry.request;
  if (!request) {
    return false;
  }
  const segments = tokenizeConcreteConfigPath(path).tokens;
  const field = segments[4];
  if (field === "auth") {
    return request.auth !== undefined;
  }
  if (field === "tls") {
    return request.tls !== undefined;
  }
  if (field === "proxy") {
    return request.proxy !== undefined;
  }
  const headerKey = segments[5];
  const headerName =
    field === "headers" && typeof headerKey === "string" ? headerKey.toLowerCase() : undefined;
  return Boolean(
    headerName &&
    Object.keys(request.headers ?? {}).some((key) => key.toLowerCase() === headerName),
  );
}

/** Rejects a cold capability request only when the model still inherits its failed field. */
export function assertRuntimeMediaRequestSecretOwnerAvailable(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
}): void {
  const owner = findActiveDegradedSecretOwner(
    "capability",
    runtimeMediaRequestSecretOwnerId(params.capability),
  );
  if (owner && owner.paths.some((path) => !modelRequestOverridesPath(params.entry, path))) {
    throw new SecretSurfaceUnavailableError(owner);
  }
}
