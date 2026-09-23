import type { ControlUiBuildInfo } from "../build-info-types.ts";

export type ControlUiE2eBuildIdentity = Pick<ControlUiBuildInfo, "buildId" | "version">;

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2ePrebuiltAssets?: {
      root: string;
      buildInfo: ControlUiE2eBuildIdentity;
    };
  }
}

let sharedPreview: {
  baseUrl: string;
  buildInfo: ControlUiE2eBuildIdentity | null;
} | null = null;

export function getSharedControlUiE2ePreview() {
  return sharedPreview;
}

export function setSharedControlUiE2eServerBaseUrl(
  baseUrl: string | null,
  buildInfo?: ControlUiE2eBuildIdentity | null,
): void {
  sharedPreview = baseUrl ? { baseUrl, buildInfo: buildInfo ?? null } : null;
}
