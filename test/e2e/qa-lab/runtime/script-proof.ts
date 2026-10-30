import { formatErrorMessage } from "../../../../src/infra/errors.js";
import type { QaScriptEvidenceStatus } from "./script-evidence.js";

type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

export async function produceQaScriptProof<TOptions>(
  options: TOptions,
  runProof: (options: TOptions) => Promise<string>,
  summaryFile: string,
): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    return {
      artifacts: [{ filePath: summaryFile, kind: "summary" }],
      details: await runProof(options),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}
