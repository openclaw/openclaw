export interface RuntimePolicy {
  beforeToolInvoke?(input: {
    toolName: string;
    args: unknown;
    sessionKey?: string;
    source: "http" | "gateway" | "agent";
  }): Promise<void>;

  afterToolInvoke?(input: {
    toolName: string;
    args: unknown;
    result: unknown;
    sessionKey?: string;
    source: "http" | "gateway" | "agent";
  }): Promise<void>;

  beforeModelCall?(input: { provider: string; model: string; request: unknown }): Promise<void>;

  afterModelCall?(input: { provider: string; model: string; response: unknown }): Promise<void>;
}
