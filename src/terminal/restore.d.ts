type RestoreTerminalStateOptions = {
    /**
     * Resumes paused stdin after restoring terminal mode.
     * Keep this off when the process should exit immediately after cleanup.
     *
     * Default: false (safer for "cleanup then exit" call sites).
     */
    resumeStdin?: boolean;
    /**
     * Alias for resumeStdin. Prefer this name to make the behavior explicit.
     *
     * Default: false.
     */
    resumeStdinIfPaused?: boolean;
};
export declare function restoreTerminalState(reason?: string, options?: RestoreTerminalStateOptions): void;
export {};
