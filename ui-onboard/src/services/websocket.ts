/**
 * WebSocket client for communicating with the onboarding server
 */

export type PromptType = "select" | "multiselect" | "text" | "confirm" | "note" | "intro" | "outro" | "progress";

export interface PromptMessage {
  type: PromptType;
  id: string;
  params: unknown;
}

export interface ResponseMessage {
  id: string;
  value: unknown;
  cancelled?: boolean;
}

export interface CompleteMessage {
  type: "complete" | "cancelled" | "error";
  message: string;
}

export interface ShutdownMessage {
  type: "shutdown";
}

export interface ShutdownAckMessage {
  type: "shutdown_ack";
}

export type MessageHandler = (message: PromptMessage) => void;
export type CompleteHandler = (message: CompleteMessage) => void;
export type ConnectionHandler = () => void;
export type ShutdownAckHandler = () => void;

export class OnboardWebSocket {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private completeHandlers: Set<CompleteHandler> = new Set();
  private connectHandlers: Set<ConnectionHandler> = new Set();
  private disconnectHandlers: Set<ConnectionHandler> = new Set();
  private shutdownAckHandlers: Set<ShutdownAckHandler> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private shutdownRequested = false;

  connect(): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("[onboard-ws] Connected");
      this.reconnectAttempts = 0;
      this.connectHandlers.forEach((handler) => handler());
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Check for shutdown acknowledgement
        if (data.type === "shutdown_ack") {
          console.log("[onboard-ws] Shutdown acknowledged by server");
          this.shutdownAckHandlers.forEach((handler) => handler());
          return;
        }

        // Check for completion messages
        if (data.type === "complete" || data.type === "cancelled" || data.type === "error") {
          this.completeHandlers.forEach((handler) => handler(data as CompleteMessage));
          return;
        }

        // Regular prompt message
        this.messageHandlers.forEach((handler) => handler(data as PromptMessage));
      } catch (error) {
        console.error("[onboard-ws] Failed to parse message:", error);
      }
    };

    this.ws.onclose = () => {
      console.log("[onboard-ws] Disconnected");
      this.disconnectHandlers.forEach((handler) => handler());
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error("[onboard-ws] Error:", error);
    };
  }

  private attemptReconnect(): void {
    // Don't reconnect if shutdown was requested
    if (this.shutdownRequested) {
      console.log("[onboard-ws] Shutdown requested, not attempting reconnection");
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[onboard-ws] Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[onboard-ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (this.ws?.readyState === WebSocket.CLOSED && !this.shutdownRequested) {
        this.connect();
      }
    }, delay);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  sendResponse(id: string, value: unknown, cancelled = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[onboard-ws] Cannot send response: not connected");
      return;
    }

    const message: ResponseMessage = { id, value, cancelled };
    this.ws.send(JSON.stringify(message));
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onComplete(handler: CompleteHandler): () => void {
    this.completeHandlers.add(handler);
    return () => this.completeHandlers.delete(handler);
  }

  onConnect(handler: ConnectionHandler): () => void {
    this.connectHandlers.add(handler);
    return () => this.connectHandlers.delete(handler);
  }

  onDisconnect(handler: ConnectionHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  onShutdownAck(handler: ShutdownAckHandler): () => void {
    this.shutdownAckHandlers.add(handler);
    return () => this.shutdownAckHandlers.delete(handler);
  }

  /**
   * Request the server to shut down.
   * This will close the WebSocket connection and stop the server.
   */
  requestShutdown(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[onboard-ws] Cannot request shutdown: not connected");
      return;
    }

    this.shutdownRequested = true;
    const message: ShutdownMessage = { type: "shutdown" };
    this.ws.send(JSON.stringify(message));
    console.log("[onboard-ws] Shutdown request sent");
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const onboardSocket = new OnboardWebSocket();
