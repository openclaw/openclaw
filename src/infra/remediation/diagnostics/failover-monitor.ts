/**
 * Self-Diagnosing Failover Monitor.
 * Detects failures in the model failover path and suggests remediation (e.g., config sync).
 * Specifically addresses the \"successful fallback but error surfaced\" class of bugs.
 */
export class FailoverMonitor {
    private successCount = 0;
    private failureCount = 0;

    recordEvent(event: "primary_failed" | "fallback_succeeded" | "run_error") {
        if (event === "fallback_succeeded") this.successCount++;
        if (event === "run_error") this.failureCount++;
        
        // Heuristic: If fallback succeeded but the run ended in error, suggest a state check.
        if (this.successCount > 0 && event === "run_error") {
            console.warn("[remediation] Detected fallback success but terminal run error. Suggesting 'openclaw doctor --fix'.");
        }
    }
}
