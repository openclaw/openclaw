/**
 * CLI commands for rate limiting and cost controls.
 *
 * openclaw limits status - Show current usage vs limits for all providers
 * openclaw limits set <provider> - Set per-provider limits
 * openclaw limits reset [provider] - Reset counters and budget tracking
 */

import type { Command } from "commander";
import { resolveRateLimitsConfig } from "../rate-limits/config.js";
import {
    getRateLimitedRunner,
    resetRateLimitedRunner,
} from "../rate-limits/provider-wrapper.js";
import type { ProviderLimitsStatus } from "../rate-limits/types.js";

function formatLimiterWindow(
    state: { current: number; limit: number; resetAtMs: number } | null,
    label: string,
): string {
    if (!state) {
        return `${label}: not configured`;
    }
    const remaining = Math.max(0, state.resetAtMs - Date.now());
    const remainingSec = Math.ceil(remaining / 1000);
    return `${label}: ${state.current}/${state.limit} (resets in ${remainingSec}s)`;
}

function printStatus(statuses: ProviderLimitsStatus[]): void {
    if (statuses.length === 0) {
        console.log("No rate-limit data recorded yet.");
        console.log("Rate limits are applied automatically when API calls are made.");
        return;
    }

    for (const status of statuses) {
        console.log(`\n  Provider: ${status.provider}`);
        console.log(`    ${formatLimiterWindow(status.rpm, "RPM")}`);
        console.log(`    ${formatLimiterWindow(status.tpm, "TPM")}`);
        console.log(`    ${formatLimiterWindow(status.rpd, "RPD")}`);

        const dailyBudget = status.dailyTokenBudget;
        if (dailyBudget) {
            const pct = dailyBudget.limit > 0 ? Math.round((dailyBudget.used / dailyBudget.limit) * 100) : 0;
            console.log(`    Daily tokens: ${dailyBudget.used.toLocaleString()} / ${dailyBudget.limit.toLocaleString()} (${pct}%)`);
        } else {
            console.log("    Daily tokens: no limit");
        }

        const monthlyBudget = status.monthlyTokenBudget;
        if (monthlyBudget) {
            const pct = monthlyBudget.limit > 0 ? Math.round((monthlyBudget.used / monthlyBudget.limit) * 100) : 0;
            console.log(`    Monthly tokens: ${monthlyBudget.used.toLocaleString()} / ${monthlyBudget.limit.toLocaleString()} (${pct}%)`);
        } else {
            console.log("    Monthly tokens: no limit");
        }

        if (status.queueDepth > 0) {
            console.log(`    Queue depth: ${status.queueDepth}`);
        }
    }
    console.log();
}

export function registerLimitsCli(program: Command): void {
    const limits = program
        .command("limits")
        .description("Rate limiting & cost controls");

    limits
        .command("status")
        .description("Show current usage vs limits for all providers")
        .action(async () => {
            try {
                const { loadConfig } = await import("../config/config.js");
                const cfg = await loadConfig();
                const limitsConfig = resolveRateLimitsConfig(cfg.limits);

                if (!limitsConfig.enabled) {
                    console.log("Rate limiting is disabled.");
                    console.log('Enable with: limits.enabled = true in openclaw.yaml');
                    return;
                }

                const runner = getRateLimitedRunner({ config: limitsConfig });
                const statuses = runner.getAllStatus();
                printStatus(statuses);
            } catch (err) {
                console.error(
                    "Failed to load rate-limit status:",
                    err instanceof Error ? err.message : err,
                );
                process.exitCode = 1;
            }
        });

    limits
        .command("set <provider>")
        .description("Set per-provider limits (RPM, TPM, budget)")
        .option("--rpm <number>", "Requests per minute")
        .option("--tpm <number>", "Tokens per minute")
        .option("--rpd <number>", "Requests per day")
        .option("--daily-tokens <number>", "Daily token budget")
        .option("--monthly-tokens <number>", "Monthly token budget")
        .action(async (provider: string, options: Record<string, string>) => {
            console.log(`Setting limits for provider: ${provider}`);
            const changes: string[] = [];
            if (options.rpm) {
                changes.push(`  rpm: ${options.rpm}`);
            }
            if (options.tpm) {
                changes.push(`  tpm: ${options.tpm}`);
            }
            if (options.rpd) {
                changes.push(`  rpd: ${options.rpd}`);
            }
            if (options.dailyTokens) {
                changes.push(`  dailyTokenBudget: ${options.dailyTokens}`);
            }
            if (options.monthlyTokens) {
                changes.push(`  monthlyTokenBudget: ${options.monthlyTokens}`);
            }
            if (changes.length === 0) {
                console.log("No options specified. Use --help for available options.");
                return;
            }
            console.log("Add this to your openclaw.yaml:\n");
            console.log("limits:");
            console.log("  providers:");
            console.log(`    ${provider}:`);
            for (const line of changes) {
                console.log(`    ${line}`);
            }
            console.log();
        });

    limits
        .command("reset")
        .argument("[provider]", "Provider to reset (omit for all)")
        .description("Reset rate-limit counters and budget tracking")
        .action(async (provider?: string) => {
            try {
                const { loadConfig } = await import("../config/config.js");
                const cfg = await loadConfig();
                const limitsConfig = resolveRateLimitsConfig(cfg.limits);

                const runner = getRateLimitedRunner({ config: limitsConfig });
                runner.reset(provider);
                resetRateLimitedRunner();

                if (provider) {
                    console.log(`Reset rate-limit counters for ${provider}.`);
                } else {
                    console.log("Reset all rate-limit counters and budget tracking.");
                }
            } catch (err) {
                console.error(
                    "Failed to reset rate limits:",
                    err instanceof Error ? err.message : err,
                );
                process.exitCode = 1;
            }
        });
}
