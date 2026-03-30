import { runSecurityAudit as runSecurityAuditImpl } from "./audit.js";

type RunSecurityAudit = typeof import("./audit.js").runSecurityAudit;

export function runSecurityAudit(
	...args: Parameters<RunSecurityAudit>
): ReturnType<RunSecurityAudit> {
	return runSecurityAuditImpl(...args);
}
