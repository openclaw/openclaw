import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";

export type GatewayServiceCommand = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
  sourcePath?: string;
} | null;

export type ServiceConfigIssue = {
  code: string;
  message: string;
  detail?: string;
  environmentKeys?: string[];
  level?: "recommended" | "aggressive";
};
