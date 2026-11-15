import type { ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";

export type ProgressCardWrite = {
  markdown?: string;
  steps?: ProgressCardStep[];
  expectedRevision?: number;
};

export function normalizeProgressCardWrite(input: ProgressCardWrite): ProgressCardWrite {
  return {
    markdown: input.markdown?.trim() ? input.markdown : undefined,
    steps: input.steps && input.steps.length > 0 ? input.steps : undefined,
    expectedRevision: input.expectedRevision,
  };
}
