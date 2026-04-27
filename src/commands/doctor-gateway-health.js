import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { formatErrorMessage } from "../infra/errors.js";
import { note } from "../terminal/note.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";
export async function checkGatewayHealth(params) {
    const gatewayDetails = buildGatewayConnectionDetails({ config: params.cfg });
    const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 10_000;
    let healthOk = false;
    try {
        await healthCommand({ json: false, timeoutMs, config: params.cfg }, params.runtime);
        healthOk = true;
    }
    catch (err) {
        const message = String(err);
        if (message.includes("gateway closed")) {
            note("Gateway not running.", "Gateway");
            note(gatewayDetails.message, "Gateway connection");
        }
        else {
            params.runtime.error(formatHealthCheckFailure(err));
        }
    }
    if (healthOk) {
        try {
            const status = await callGateway({
                method: "channels.status",
                params: { probe: true, timeoutMs: 5000 },
                timeoutMs: 6000,
            });
            const issues = collectChannelStatusIssues(status);
            if (issues.length > 0) {
                note(issues
                    .map((issue) => `- ${issue.channel} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`)
                    .join("\n"), "Channel warnings");
            }
        }
        catch {
            // ignore: doctor already reported gateway health
        }
    }
    return { healthOk };
}
export async function probeGatewayMemoryStatus(params) {
    const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 8_000;
    try {
        const payload = await callGateway({
            method: "doctor.memory.status",
            timeoutMs,
            config: params.cfg,
        });
        return {
            checked: true,
            ready: payload.embedding.ok,
            error: payload.embedding.error,
        };
    }
    catch (err) {
        const message = formatErrorMessage(err);
        return {
            checked: true,
            ready: false,
            error: `gateway memory probe unavailable: ${message}`,
        };
    }
}
