declare module "@copilotkit/aimock" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export type ChatCompletionMessage = {
    role?: string;
    content?: unknown;
  };

  export type ChatCompletionRequest = {
    model?: string;
    messages?: ChatCompletionMessage[];
  };

  export type JournalEntry = {
    path?: string;
    body?: ChatCompletionRequest | Record<string, unknown> | null;
    response?: {
      fixture?: {
        response?: {
          toolCalls?: Array<{ name?: unknown }>;
        };
      };
    };
  };

  export type Mountable = {
    handleRequest(
      req: IncomingMessage,
      res: ServerResponse,
      pathname: string,
    ): boolean | Promise<boolean>;
  };

  export class LLMock {
    constructor(options?: {
      host?: string;
      port?: number;
      strict?: boolean;
      logLevel?: string;
    });
    readonly baseUrl: string;
    getRequests(): JournalEntry[];
    mount(prefix: string, mountable: Mountable): void;
    onMessage(pattern: RegExp | string, response: { content: string }): void;
    start(): Promise<void>;
    stop(): Promise<void>;
  }
}
