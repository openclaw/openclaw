import type { GatewayServiceCommandConfig, GatewayServiceInstallArgs } from "./service-types.js";

export type GatewayServiceCommand = GatewayServiceCommandConfig | null;

export type GatewayServiceExpectedCommand = Pick<
  GatewayServiceInstallArgs,
  "programArguments" | "workingDirectory" | "environment" | "environmentValueSources"
>;

export type ServiceDefinitionDrift = {
  key: string;
  message: string;
  sourcePath?: string;
} & (
  | {
      kind: "outdated";
      current: string | number | boolean | null;
      expected: string | number | boolean;
    }
  | { kind: "unknown-edit"; reason: string }
  | { kind: "preserved" }
);

export type ServiceConfigIssue = {
  code: string;
  message: string;
  detail?: string;
  environmentKeys?: string[];
  level?: "recommended" | "aggressive";
};
