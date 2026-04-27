import { type DoctorConfigMutationState } from "./shared/config-mutation-state.js";
export declare function runDoctorRepairSequence(params: {
    state: DoctorConfigMutationState;
    doctorFixCommand: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    state: DoctorConfigMutationState;
    changeNotes: string[];
    warningNotes: string[];
}>;
