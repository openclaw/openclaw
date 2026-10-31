export type ConfigFileWritePathSnapshot = {
  targetPath: string;
  entries: Array<
    | { path: string; kind: "missing-directory" }
    | { path: string; kind: "existing"; dev: string; ino: string; link?: string }
  >;
};
