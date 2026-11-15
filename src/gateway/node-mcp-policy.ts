import { NODE_MCP_TOOLS_CALL_COMMAND } from "../infra/node-commands.js";
import { canInvokeNodeMcpLocally } from "./node-command-policy.js";
import { NodeMcpElicitationRegistry } from "./node-mcp-elicitation.js";
import type { NodeSession } from "./node-session.types.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { closeGatewayTransportWithGrace } from "./server/connection-transport-close.js";

/** Own MCP permissions and pending questions for this Gateway’s paired node sessions. */
export class NodeMcpPolicy {
  readonly elicitation = new NodeMcpElicitationRegistry();
  private readonly permissions = new WeakMap<NodeSession, boolean>();

  constructor(
    private readonly sessions: ReadonlyMap<string, NodeSession>,
    private readonly sendEvent: (node: NodeSession, event: string, payload: unknown) => boolean,
  ) {}

  readonly setAvailableForConnection = (
    identity: Pick<NodeSession, "nodeId" | "connId">,
    available: boolean,
  ): void => {
    const session = this.sessions.get(identity.nodeId);
    if (session?.connId === identity.connId) {
      this.setAvailable(session, available);
    }
  };

  retire(node: NodeSession | undefined): void {
    if (node) {
      this.elicitation.retire(node);
      this.setAvailable(node, false);
    }
  }

  private send(node: NodeSession, allowed: boolean): void {
    if (
      !this.sendEvent(node, "node.worker.localMcpPolicy", { allowed }) &&
      node.client.socket.readyState === WEBSOCKET_OPEN_READY_STATE
    ) {
      closeGatewayTransportWithGrace(node.client.socket, 1011, "MCP policy delivery failed");
    }
  }

  private setAvailable(node: NodeSession, available: boolean): void {
    const previous = this.permissions.get(node);
    if (!available) {
      this.permissions.delete(node);
      if (previous === true) {
        this.send(node, false);
      }
      return;
    }
    const allowed = canInvokeNodeMcpLocally(node.commands);
    if (allowed !== previous) {
      this.permissions.set(node, allowed);
      this.send(node, allowed);
    }
  }

  refresh(node: NodeSession, questionsEnabled: boolean): void {
    if (!questionsEnabled || !node.commands.includes(NODE_MCP_TOOLS_CALL_COMMAND)) {
      this.elicitation.retire(node);
    }
    if (this.permissions.has(node)) {
      this.setAvailable(node, true);
    }
  }
}
