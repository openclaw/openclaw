declare module "@openclaw/core-memories" {
  export type CoreMemoriesInitOptions = { memoryDir?: string };

  export function getCoreMemories(opts?: CoreMemoriesInitOptions): Promise<{
    addFlashEntry: (text: string, speaker?: string, type?: string) => unknown;
  }>;
}

declare module "@openclaw/core-memories/integration" {
  export function heartbeatMaintenance(opts?: { memoryDir?: string }): Promise<unknown>;
}
