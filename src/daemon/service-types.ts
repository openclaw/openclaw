export type GatewayServiceEnv = Record<string, string | undefined>;
export type SystemdKillMode = "process" | "mixed" | "control-group";

export type GatewayServiceInstallArgs = {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  description?: string;
  systemdKillMode?: SystemdKillMode;
};

export type GatewayServiceManageArgs = {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
};

export type GatewayServiceControlArgs = {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
};

export type GatewayServiceEnvArgs = {
  env?: GatewayServiceEnv;
};

export type GatewayServiceCommandConfig = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  sourcePath?: string;
};

export type GatewayServiceRenderArgs = {
  description?: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  killMode?: SystemdKillMode;
};
