export type SystemdEnvironmentFileSpec = [pathname: string, optional: boolean];

export type SystemdCommandSnapshotParams = {
  programArguments: string[];
  workingDirectory: string;
  inlineEnvironment: Record<string, string>;
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  unsetEnvironment: string[];
  failOnUnavailable?: boolean;
};

export type SystemdEnvironmentFilesParams = {
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  failOnUnavailable?: boolean;
};
