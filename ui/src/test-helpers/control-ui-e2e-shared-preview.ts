import type { ProvidedContext } from "vitest";
import type { ControlUiBuildInfo } from "../build-info-types.ts";

export type ControlUiE2ePrebuiltAssets = {
  root: string;
  buildInfo: Pick<ControlUiBuildInfo, "buildId" | "version">;
};

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2ePrebuiltAssets?: ControlUiE2ePrebuiltAssets;
  }
}

export type ControlUiE2eBuildIdentity = NonNullable<
  ProvidedContext["controlUiE2ePrebuiltAssets"]
>["buildInfo"];

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
