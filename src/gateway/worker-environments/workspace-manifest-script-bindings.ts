type WorkspaceManifestProgramProcess = {
  argv: string[];
  env: { HOME: string };
  pid: number;
  platform: NodeJS.Platform;
  stdout: { write: (value: string) => void };
  // Publish consumes stdin in the remote program; native capture never supplies it.
  stdin?: AsyncIterable<Uint8Array | string>;
};

export type WorkspaceManifestProgram = (
  process: WorkspaceManifestProgramProcess,
  readManifestInput: () => string,
  assertManifestCurrent: () => void,
  readManifestGit: (root: string, args: string[], maxOutputBytes: number) => Promise<Buffer>,
  maxHashMemoBytes: number,
) => Promise<void>;
