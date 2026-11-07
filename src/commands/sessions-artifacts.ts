// The Gateway owns artifact storage and its download transports; this command
// only lists and fetches, like the other gateway-backed session verbs.
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type SessionsArtifactsOptions = {
  sessionKey: string;
  artifactId?: string;
  run?: string;
  agent?: string;
  output?: string;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

function describeSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) {
    return "—";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes}B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)}KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function renderArtifactsList(result: ArtifactsListResult): string {
  const artifacts = result.artifacts ?? [];
  if (artifacts.length === 0) {
    return "No artifacts in this scope.";
  }
  return renderTable({
    width: getTerminalTableWidth(),
    columns: [
      { key: "Id", header: "Id", minWidth: 14 },
      { key: "Type", header: "Type", minWidth: 10 },
      { key: "Title", header: "Title", minWidth: 18, flex: true },
      { key: "Size", header: "Size", minWidth: 8 },
      { key: "Run", header: "Run", minWidth: 10 },
    ],
    rows: artifacts.map((artifact) => ({
      Id: sanitizeTerminalText(artifact.id),
      Type: sanitizeTerminalText(artifact.type).slice(0, 24),
      Title: sanitizeTerminalText(artifact.title).slice(0, 60),
      Size: describeSize(artifact.sizeBytes),
      Run: sanitizeTerminalText(artifact.runId ?? "—").slice(0, 24),
    })),
  }).trimEnd();
}

export async function sessionsArtifactsCommand(
  opts: SessionsArtifactsOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const sessionKey = opts.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("Session key must not be blank.");
  }
  const artifactId = opts.artifactId?.trim() || undefined;
  if (opts.artifactId !== undefined && !artifactId) {
    throw new Error("Artifact id must not be blank.");
  }
  const run = opts.run?.trim() || undefined;
  if (opts.run !== undefined && !run) {
    throw new Error("--run must not be blank.");
  }
  const agent = opts.agent?.trim() || undefined;
  if (opts.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }

  const rpcOpts: Parameters<typeof callGatewayFromCliWithTransport>[1] = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    json: opts.json,
  };
  const scope = {
    sessionKey,
    ...(run ? { runId: run } : {}),
    ...(agent ? { agentId: agent } : {}),
  };

  let listResult: ArtifactsListResult | undefined;
  let downloadResult: ArtifactsDownloadResult | undefined;
  try {
    if (artifactId) {
      downloadResult = await callGatewayFromCliWithTransport<ArtifactsDownloadResult>(
        "artifacts.download",
        rpcOpts,
        { ...scope, artifactId },
        { defaultTimeoutMs: 30_000 },
      );
    } else {
      listResult = await callGatewayFromCliWithTransport<ArtifactsListResult>(
        "artifacts.list",
        rpcOpts,
        scope,
        { defaultTimeoutMs: 30_000 },
      );
    }
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), sessionKey });
    } else {
      runtime.error(`Artifacts read failed: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, downloadResult ?? listResult);
    return;
  }
  if (!artifactId) {
    if (!listResult) {
      return;
    }
    runtime.log(renderArtifactsList(listResult));
    return;
  }

  const download = downloadResult;
  if (!download) {
    return;
  }
  const artifact = download.artifact;
  const mode = artifact.download.mode;
  if (mode === "unsupported") {
    runtime.error(`Artifact ${sanitizeTerminalText(artifactId)} cannot be downloaded inline.`);
    runtime.exit(1);
    return;
  }
  if (mode === "url" && download.url) {
    runtime.log(sanitizeTerminalText(download.url));
    return;
  }
  // mode === "bytes": the Gateway returns base64 bytes for inline transfer.
  if (download.encoding === "base64" && download.data) {
    const bytes = Buffer.from(download.data, "base64");
    if (opts.output) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(opts.output, bytes);
      runtime.log(`Wrote ${sanitizeTerminalText(opts.output)} (${bytes.length} bytes).`);
      return;
    }
    runtime.log(
      `${theme.muted("Use --output to save the bytes.")} ${sanitizeTerminalText(artifact.id)} (${bytes.length} bytes, ${sanitizeTerminalText(artifact.mimeType ?? "unknown")})`,
    );
    return;
  }
  runtime.log(`${sanitizeTerminalText(artifact.id)}: ${sanitizeTerminalText(artifact.title)}`);
}
