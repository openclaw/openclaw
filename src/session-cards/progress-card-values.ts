import type { ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import type { ProgressWorkCustody, ProgressWorkIntent } from "./progress-card-work-intent.js";
import type { ProgressWorkCommand } from "./progress-card-work.js";

export type ProgressCardWrite = {
  managedWork?: ProgressWorkCustody & { intent?: ProgressWorkIntent };
  workCommand?: ProgressWorkCommand;
  markdown?: string;
  steps?: ProgressCardStep[];
  expectedRevision?: number;
};

export function normalizeProgressCardWrite(input: ProgressCardWrite): ProgressCardWrite {
  return {
    managedWork: input.managedWork,
    workCommand: input.workCommand,
    markdown: input.markdown?.trim() ? input.markdown : undefined,
    steps: input.steps && input.steps.length > 0 ? input.steps : undefined,
    expectedRevision: input.expectedRevision,
  };
}
