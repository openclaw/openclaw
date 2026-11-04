import type { StreamFn } from "./agent-core.js";
import type { Model, SimpleStreamOptions } from "./llm.js";

/** Final SDK-serialized HTTP request, before a proxy owns destination and authentication. */
export type SerializedConverseRequest = {
  method: string;
  path: string;
  query: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body: unknown;
};

/** One caller-owned proxy transport. It never grants access to AWS credentials or endpoints. */
export type ConverseProxyTransport = {
  endpoint: string;
  apiKey: string;
  send(
    request: SerializedConverseRequest,
    signal?: AbortSignal,
  ): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: Uint8Array;
  }>;
};

/** Resolve a selected proxy credential and transport for each physical model request. */
export type ConverseProxyTransportFactory = (
  model: Model<"bedrock-converse-stream">,
  options: SimpleStreamOptions,
) => Promise<ConverseProxyTransport>;

/** Reuse the native Converse serializer, replay and EventStream decoder with a proxy transport. */
export function createConverseStreamFn(transport: ConverseProxyTransportFactory): StreamFn {
  return async (model, context, options) => {
    const { loadBundledPluginPublicSurfaceModuleSync } = await import("./facade-runtime.js");
    const runtime = loadBundledPluginPublicSurfaceModuleSync<{
      createConverseStreamFn(transport: ConverseProxyTransportFactory): StreamFn;
    }>({ dirName: "amazon-bedrock", artifactBasename: "runtime-api" });
    return runtime.createConverseStreamFn(transport)(model, context, options);
  };
}
