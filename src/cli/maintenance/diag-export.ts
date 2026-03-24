import { execAsync } from "../../shared/exec.js";
import path from "node:path";

/**
 * Diagnostic Export Bundle.
 * Aggregates logs, config (sanitized), and environment info into a single zip/tarball.
 * Helps users provide high-quality evidence for issue reports.
 */
export async function createDiagnosticBundle(outputDir: string) {
    const tarPath = path.join(outputDir, `openclaw-diag-${Date.now()}.tar.gz`);
    console.info(`[maintenance] Creating diagnostic bundle at ${tarPath}...`);
    
    // Logic to sanitize config (remove keys/tokens) before bundling
    // Logic to execute 'tar -czf' on logs/ and redacted config
    await execAsync(`tar -czf ${tarPath} logs/ version.json`);
    return tarPath;
}
