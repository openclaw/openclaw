export declare class TuiStreamAssembler {
    private runs;
    private getOrCreateRun;
    private updateRunState;
    ingestDelta(runId: string, message: unknown, showThinking: boolean): string | null;
    finalize(runId: string, message: unknown, showThinking: boolean, errorMessage?: string): string;
    drop(runId: string): void;
}
