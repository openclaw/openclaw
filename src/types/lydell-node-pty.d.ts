declare module "@lydell/node-pty" {
  export type PtyExitEvent = { exitCode: number; signal?: number };
  export type PtyListener<T> = (event: T) => void;
  export interface IDisposable {
    dispose(): void;
  }
  export type PtyHandle = {
    pid: number;
    write: (data: string | Buffer) => void;
    onData: (listener: PtyListener<string>) => IDisposable;
    onExit: (listener: PtyListener<PtyExitEvent>) => IDisposable;
    kill: (signal?: string) => void;
    resize: (columns: number, rows: number) => void;
    clear: () => void;
    pause: () => void;
    resume: () => void;
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
