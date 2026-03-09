/**
 * Real OpenClaw WebSocket Connection
 * Direct connection to OpenClaw gateway (ws://127.0.0.1:18789)
 * No simulation - real data, real commands
 */

export interface OpenClawMessage {
  type: "command" | "response" | "event" | "error";
  id?: string;
  command?: string;
  data?: any;
  error?: string;
}

export interface AgentStatus {
  id: string;
  name: string;
  status: "active" | "inactive" | "error";
  task?: string;
  lastSeen?: number;
}

export interface SystemStatus {
  gateway: {
    state: "running" | "stopped" | "error";
    port: number;
    version?: string;
  };
  agents: {
    total: number;
    active: number;
    list: AgentStatus[];
  };
  plugins: {
    telegram: boolean;
    webchat: boolean;
    [key: string]: boolean;
  };
}

class OpenClawWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private messageCallbacks: Map<string, (data: any) => void> = new Map();
  private eventCallbacks: Map<string, ((data: any) => void)[]> = new Map();
  private isConnected = false;

  constructor(private gatewayUrl: string = "ws://127.0.0.1:18789") {}

  /**
   * Connect to OpenClaw gateway
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.onopen = () => {
          console.log("✅ Connected to OpenClaw gateway");
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.emit("connected");
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message: OpenClawMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error("Failed to parse WebSocket message:", error);
          }
        };

        this.ws.onerror = (error) => {
          console.error("WebSocket error:", error);
          this.emit("error", error);
          reject(error);
        };

        this.ws.onclose = () => {
          console.log("WebSocket disconnected");
          this.isConnected = false;
          this.emit("disconnected");
          this.attemptReconnect();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from OpenClaw gateway
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  /**
   * Send command to OpenClaw
   */
  sendCommand(command: string, data?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected || !this.ws) {
        reject(new Error("Not connected to OpenClaw gateway"));
        return;
      }

      const messageId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const message: OpenClawMessage = {
        type: "command",
        id: messageId,
        command,
        data,
      };

      this.messageCallbacks.set(messageId, (response) => {
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.data);
        }
      });

      this.ws.send(JSON.stringify(message));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.messageCallbacks.has(messageId)) {
          this.messageCallbacks.delete(messageId);
          reject(new Error(`Command timeout: ${command}`));
        }
      }, 30000);
    });
  }

  /**
   * Get system status
   */
  async getSystemStatus(): Promise<SystemStatus> {
    try {
      // Try to get status via WebSocket
      const response = await this.sendCommand("status");
      return response;
    } catch (error) {
      console.warn("WebSocket status failed, falling back to HTTP");

      // Fallback to HTTP
      try {
        const httpResponse = await fetch("http://127.0.0.1:18789/status");
        if (httpResponse.ok) {
          return await httpResponse.json();
        }
      } catch (httpError) {
        console.error("HTTP status also failed:", httpError);
      }

      // Return default error status
      return {
        gateway: {
          state: "error",
          port: 18789,
        },
        agents: {
          total: 0,
          active: 0,
          list: [],
        },
        plugins: {
          telegram: false,
          webchat: false,
        },
      };
    }
  }

  /**
   * Get agent list
   */
  async getAgents(): Promise<AgentStatus[]> {
    try {
      const response = await this.sendCommand("agents.list");
      return response.agents || [];
    } catch (error) {
      console.error("Failed to get agents:", error);
      return [];
    }
  }

  /**
   * Send message to agent
   */
  async sendToAgent(agentId: string, message: string): Promise<void> {
    await this.sendCommand("agent.message", { agentId, message });
  }

  /**
   * Spawn agent
   */
  async spawnAgent(agentId: string, task?: string): Promise<void> {
    await this.sendCommand("agent.spawn", { agentId, task });
  }

  /**
   * Kill agent
   */
  async killAgent(agentId: string): Promise<void> {
    await this.sendCommand("agent.kill", { agentId });
  }

  /**
   * Subscribe to events
   */
  on(event: string, callback: (data: any) => void): void {
    if (!this.eventCallbacks.has(event)) {
      this.eventCallbacks.set(event, []);
    }
    this.eventCallbacks.get(event).push(callback);
  }

  /**
   * Unsubscribe from events
   */
  off(event: string, callback: (data: any) => void): void {
    const callbacks = this.eventCallbacks.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  /**
   * Check connection status
   */
  get connected(): boolean {
    return this.isConnected;
  }

  private handleMessage(message: OpenClawMessage) {
    // Handle command responses
    if (message.id && this.messageCallbacks.has(message.id)) {
      const callback = this.messageCallbacks.get(message.id);
      callback(message);
      this.messageCallbacks.delete(message.id);
    }

    // Handle events
    if (message.type === "event") {
      this.emit(message.command || "event", message.data);
    }
  }

  private emit(event: string, data?: any) {
    const callbacks = this.eventCallbacks.get(event);
    if (callbacks) {
      callbacks.forEach((callback) => callback(data));
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);

    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    setTimeout(() => {
      if (!this.isConnected) {
        this.connect().catch((error) => {
          console.error("Reconnection failed:", error);
        });
      }
    }, delay);
  }
}

// Singleton instance
export const openclawWS = new OpenClawWebSocket();

export default openclawWS;
