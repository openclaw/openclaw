declare module "@lydell/node-pty" {
  export type PtyExitEvent = { exitCode: number; signal?: number };
  export type PtyListener<T> = (event: T) => void;
  export type PtyDisposable = { dispose: () => void };
  export type PtyHandle = {
    pid: number;
    write: (data: string | Buffer) => void;
    onData: (listener: PtyListener<string>) => PtyDisposable;
    onExit: (listener: PtyListener<PtyExitEvent>) => PtyDisposable;
    kill: (signal?: string) => void;
  };

  export type PtySpawn = (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => PtyHandle;

  export const spawn: PtySpawn;
}
