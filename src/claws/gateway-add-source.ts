import path from "node:path";
import type { ClawsAddPlanParams } from "../../packages/gateway-protocol/src/schema/claws.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import { withResolvedClawHubSource, type ClawHubClawTrust } from "./clawhub-source.js";
import { readClawManifestFile } from "./reader.js";
import type { ClawReadResult } from "./types.js";

export type GatewayClawAddSource = ClawsAddPlanParams["source"];
export type GatewayClawSourceTrust = Pick<
  ClawHubClawTrust,
  "trustWarning" | "riskAcknowledgementRequired"
> &
  Partial<Pick<ClawHubClawTrust, "trustRecord">>;
type ResolvedSource = Extract<ClawReadResult, { ok: true }>;

export class ClawLocalSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawLocalSourceError";
  }
}

export async function withResolvedGatewayClawAddSource<T>(
  params: ClawHubFetchOptions & {
    source: GatewayClawAddSource;
    mode: "preview" | "apply";
    acknowledgeClawHubRisk?: boolean;
    stateDir?: string;
    run: (
      source: ResolvedSource,
      trust: GatewayClawSourceTrust,
      persistSource: () => Promise<ResolvedSource>,
    ) => Promise<T>;
  },
): Promise<{ value: T }> {
  if (!("localPath" in params.source)) {
    return await withResolvedClawHubSource({ ...params, coordinate: params.source });
  }
  if (!path.isAbsolute(params.source.localPath)) {
    throw new ClawLocalSourceError(
      "Local Claw source must be an absolute path on the Gateway host.",
    );
  }
  const source = await readClawManifestFile(params.source.localPath);
  if (!source.ok) {
    throw new ClawLocalSourceError(
      source.diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("\n"),
    );
  }
  // Local packages already live on this host. The native reader binds their content
  // snapshot; Add verifies managed file digests when copying into the new workspace.
  return {
    value: await params.run(source, { riskAcknowledgementRequired: false }, async () => source),
  };
}
