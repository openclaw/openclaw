import type {
  WorkerGatewayToolCancelParams,
  WorkerGatewayToolInvokeParams,
  WorkerGatewayToolResult,
  WorkerGatewayToolUpdateFrame,
  WorkerToolSurface,
} from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { WorkerInferenceContext } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";

export type WorkerGatewayToolSink = { send(frame: WorkerGatewayToolUpdateFrame): void };

export type WorkerGatewayToolRuntime = {
  applyPromptToolsAllow(toolsAllow?: string[]): string[];
  getSurface(identity: WorkerConnectionIdentity): Promise<WorkerToolSurface>;
  getPromptProjection(identity: WorkerConnectionIdentity): Promise<{
    tools: NonNullable<WorkerInferenceContext["tools"]>;
    toolSchemaDirectoryPrompt?: string;
  }>;
  invoke(
    identity: WorkerConnectionIdentity,
    request: WorkerGatewayToolInvokeParams,
    sink: WorkerGatewayToolSink,
    connectionSignal?: AbortSignal,
  ): Promise<WorkerGatewayToolResult>;
  cancel(request: WorkerGatewayToolCancelParams): { cancelled: boolean };
  abort(): void;
  close(): Promise<void>;
};
