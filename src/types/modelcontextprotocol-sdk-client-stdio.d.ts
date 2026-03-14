declare module "@modelcontextprotocol/sdk/client/stdio" {
  import type { IOType } from "node:child_process";
  import type { Stream } from "node:stream";

  export type StdioServerParameters = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: IOType | Stream | number;
    cwd?: string;
  };

  export class StdioClientTransport {
    constructor(server: StdioServerParameters);
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;
    get stderr(): Stream | null;
    get pid(): number | null;
    start(): Promise<void>;
    close(): Promise<void>;
    send(message: unknown): Promise<void>;
  }
}
