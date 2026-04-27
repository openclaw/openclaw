import { runSecurityAudit as runSecurityAuditImpl } from "./audit.js";
export function runSecurityAudit(...args) {
    return runSecurityAuditImpl(...args);
}
