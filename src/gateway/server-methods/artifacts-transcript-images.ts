import type { ArtifactsGetParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionArtifacts } from "../session-transcript-readers.js";
import type { ArtifactLookup } from "./artifacts-content.js";
import { prepareArtifactSessionRead } from "./artifacts-session-read.js";
import type { GatewayClient } from "./types.js";

/** Recover only the referenced persisted bitmap; transcript bytes remain in their existing owner. */
export async function findTranscriptImageArtifact(
  params: ArtifactsGetParams,
  getRuntimeConfig: () => OpenClawConfig | undefined,
  includeData: boolean,
  client: GatewayClient | null,
): Promise<ArtifactLookup> {
  const selected = await prepareArtifactSessionRead(params, getRuntimeConfig, client);
  if (!selected?.scope) {
    return { sessionKey: selected?.sessionKey };
  }
  const { artifact } = await readSessionArtifacts(selected.scope, {
    kind: "image",
    sessionKey: selected.sessionKey,
    artifactId: params.artifactId,
    includeData,
    runId: params.runId,
    messageRole: params.messageRole,
  });
  selected.assertCurrent();
  return { sessionKey: selected.sessionKey, assertCurrent: selected.assertCurrent, artifact };
}
