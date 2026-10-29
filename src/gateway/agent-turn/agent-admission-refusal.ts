import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readPreparedRuntimeSelfHold } from "../../agents/prepared-model-runtime-admission.js";

export type AgentAdmissionStage =
  | "runtime-preparation"
  | "subagent-preparation"
  | "input-preparation"
  | "acceptance";
type AgentAdmissionRefusal = Readonly<{
  acceptance: "not_accepted" | "uncertain";
  stage: AgentAdmissionStage;
}>;
const refusals = new WeakMap<object, AgentAdmissionRefusal>();
/** The dispatch ports refusal uses; agent-tool readers import this module, so it stays a leaf. */
type AgentPreacceptRefusalPorts = {
  releaseUnacceptedReservation: () => boolean;
  io: { emitAcceptance: (acceptance: readonly [false, undefined, ErrorShape]) => void };
};
/** Admission advances `stage` as it passes each preparation boundary. */
type AgentPreacceptRefusal = {
  (error: ErrorShape): Promise<undefined>;
  stage: AgentAdmissionStage;
};

/** Admission alone stamps the original guard cause after joining its cleanup. */
export function recordAgentAdmissionRefusal(
  error: unknown,
  stage: AgentAdmissionStage,
  released: boolean,
) {
  const selfHeld = readPreparedRuntimeSelfHold(error);
  if (selfHeld) {
    refusals.set(selfHeld.cause, {
      acceptance: stage === "runtime-preparation" && released ? "not_accepted" : "uncertain",
      stage,
    });
  }
}

/** Read the paired host facts; an error flag or plugin-authored JSON never supplies proof. */
export function readAgentSelfHeldRefusal(error: unknown) {
  const held = readPreparedRuntimeSelfHold(error);
  if (!held) {
    return undefined;
  }
  return {
    ...held,
    admission: refusals.get(held.cause) ?? {
      acceptance: "uncertain" as const,
      stage: "acceptance" as const,
    },
  };
}

export function createAgentPreacceptRefusal(
  params: AgentPreacceptRefusalPorts,
  cleanup: (released?: boolean, failure?: string) => Promise<void>,
): AgentPreacceptRefusal {
  const initialStage: AgentAdmissionStage = "runtime-preparation";
  const reject: AgentPreacceptRefusal = Object.assign(
    async (error: ErrorShape): Promise<undefined> => {
      let released = false;
      try {
        await cleanup(false, error.message);
        if (readPreparedRuntimeSelfHold(error)) {
          released = params.releaseUnacceptedReservation();
        }
      } finally {
        recordAgentAdmissionRefusal(error, reject.stage, released);
        params.io.emitAcceptance([false, undefined, error]);
      }
      return undefined;
    },
    { stage: initialStage },
  );
  return reject;
}
