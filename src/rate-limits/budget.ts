/**
 * Daily/monthly token budget tracker with threshold warnings.
 *
 * Tracks cumulative token usage per provider per day and per month.
 * Persists state to a JSON file in the state directory so budgets
 * survive gateway restarts.
 */

import fs from "node:fs";
import path from "node:path";
import type {
    BudgetCheckResult,
    BudgetWarning,
    RateLimitProviderConfig,
    RateLimitScope,
} from "./types.js";

type PeriodKey = string; // "2026-02-11" or "2026-02"

type BudgetRecord = {
    dailyTokens: Record<PeriodKey, Record<string, number>>; // day → provider → tokens
    monthlyTokens: Record<PeriodKey, Record<string, number>>; // month → provider → tokens
    /** Thresholds that have already fired (to avoid re-emitting). */
    firedThresholds: Record<string, Set<number>>;
};

function todayKey(): PeriodKey {
    return new Date().toISOString().slice(0, 10);
}

function monthKey(): PeriodKey {
    return new Date().toISOString().slice(0, 7);
}

function scopeKey(scope: RateLimitScope): string {
    return scope.model ? `${scope.provider}/${scope.model}` : scope.provider;
}

function ensureRecord(): BudgetRecord {
    return { dailyTokens: {}, monthlyTokens: {}, firedThresholds: {} };
}

export class BudgetTracker {
    private record: BudgetRecord;
    private readonly filePath: string | null;
    private readonly warningThresholds: number[];
    private readonly hardBlock: boolean;
    private readonly providerLimits: Record<string, RateLimitProviderConfig>;
    private readonly defaultLimits: RateLimitProviderConfig;
    private dirty = false;

    constructor(params: {
        stateDir?: string;
        warningThresholds?: number[];
        hardBlock?: boolean;
        providerLimits?: Record<string, RateLimitProviderConfig>;
        defaultLimits?: RateLimitProviderConfig;
    }) {
        this.warningThresholds = params.warningThresholds ?? [0.8, 0.9, 1.0];
        this.hardBlock = params.hardBlock ?? false;
        this.providerLimits = params.providerLimits ?? {};
        this.defaultLimits = params.defaultLimits ?? {};
        this.filePath = params.stateDir
            ? path.join(params.stateDir, "rate-limits", "budget.json")
            : null;
        this.record = this.load();
    }

    /** Record token usage after an API call completes. Returns any new warnings. */
    record_usage(scope: RateLimitScope, tokens: number): BudgetWarning[] {
        if (tokens <= 0) {
            return [];
        }
        const key = scopeKey(scope);
        const day = todayKey();
        const month = monthKey();

        // Accumulate daily.
        if (!this.record.dailyTokens[day]) {
            this.record.dailyTokens[day] = {};
        }
        this.record.dailyTokens[day][key] = (this.record.dailyTokens[day][key] ?? 0) + tokens;

        // Accumulate monthly.
        if (!this.record.monthlyTokens[month]) {
            this.record.monthlyTokens[month] = {};
        }
        this.record.monthlyTokens[month][key] = (this.record.monthlyTokens[month][key] ?? 0) + tokens;

        this.dirty = true;
        this.scheduleSave();

        return this.checkThresholds(scope);
    }

    /** Check whether the budget allows a new request. */
    checkBudget(scope: RateLimitScope): BudgetCheckResult {
        const limits = this.resolveLimits(scope);
        const key = scopeKey(scope);
        const warnings: BudgetWarning[] = [];
        let allowed = true;

        const dailyUsed = this.record.dailyTokens[todayKey()]?.[key] ?? 0;
        if (limits.dailyTokenBudget !== undefined && limits.dailyTokenBudget > 0) {
            if (dailyUsed >= limits.dailyTokenBudget && this.hardBlock) {
                allowed = false;
            }
            warnings.push(
                ...this.buildWarnings(scope, dailyUsed, limits.dailyTokenBudget, "daily"),
            );
        }

        const monthlyUsed = this.record.monthlyTokens[monthKey()]?.[key] ?? 0;
        if (limits.monthlyTokenBudget !== undefined && limits.monthlyTokenBudget > 0) {
            if (monthlyUsed >= limits.monthlyTokenBudget && this.hardBlock) {
                allowed = false;
            }
            warnings.push(
                ...this.buildWarnings(scope, monthlyUsed, limits.monthlyTokenBudget, "monthly"),
            );
        }

        return { allowed, warnings };
    }

    /** Get current budget status for a provider. */
    getStatus(scope: RateLimitScope): {
        dailyUsedTokens: number;
        monthlyUsedTokens: number;
        dailyLimitTokens?: number;
        monthlyLimitTokens?: number;
    } {
        const limits = this.resolveLimits(scope);
        const key = scopeKey(scope);
        return {
            dailyUsedTokens: this.record.dailyTokens[todayKey()]?.[key] ?? 0,
            monthlyUsedTokens: this.record.monthlyTokens[monthKey()]?.[key] ?? 0,
            dailyLimitTokens: limits.dailyTokenBudget,
            monthlyLimitTokens: limits.monthlyTokenBudget,
        };
    }

    /** Reset budget tracking for one provider or all. */
    reset(scope?: RateLimitScope): void {
        if (scope) {
            const key = scopeKey(scope);
            for (const day of Object.values(this.record.dailyTokens)) {
                delete day[key];
            }
            for (const month of Object.values(this.record.monthlyTokens)) {
                delete month[key];
            }
            delete this.record.firedThresholds[key];
        } else {
            this.record = ensureRecord();
        }
        this.dirty = true;
        this.scheduleSave();
    }

    /** List all providers that have budget data. */
    trackedProviders(): string[] {
        const keys = new Set<string>();
        const day = this.record.dailyTokens[todayKey()];
        if (day) {
            for (const k of Object.keys(day)) {
                keys.add(k);
            }
        }
        const month = this.record.monthlyTokens[monthKey()];
        if (month) {
            for (const k of Object.keys(month)) {
                keys.add(k);
            }
        }
        return [...keys];
    }

    private resolveLimits(scope: RateLimitScope): RateLimitProviderConfig {
        return {
            ...this.defaultLimits,
            ...this.providerLimits[scope.provider],
        };
    }

    private buildWarnings(
        scope: RateLimitScope,
        currentTokens: number,
        limitTokens: number,
        period: "daily" | "monthly",
    ): BudgetWarning[] {
        const key = `${scopeKey(scope)}:${period}`;
        if (!this.record.firedThresholds[key]) {
            this.record.firedThresholds[key] = new Set();
        }
        const fired = this.record.firedThresholds[key];
        const warnings: BudgetWarning[] = [];
        const ratio = currentTokens / limitTokens;

        for (const threshold of this.warningThresholds) {
            if (ratio >= threshold && !fired.has(threshold)) {
                fired.add(threshold);
                warnings.push({ level: threshold, scope, currentTokens, limitTokens, period });
            }
        }
        return warnings;
    }

    private checkThresholds(scope: RateLimitScope): BudgetWarning[] {
        const { warnings } = this.checkBudget(scope);
        return warnings;
    }

    // --- Persistence ---

    private load(): BudgetRecord {
        if (!this.filePath) {
            return ensureRecord();
        }
        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const parsed = JSON.parse(raw) as BudgetRecord;
            // Restore Set instances from arrays.
            if (parsed.firedThresholds) {
                for (const [key, value] of Object.entries(parsed.firedThresholds)) {
                    parsed.firedThresholds[key] = new Set(
                        Array.isArray(value) ? value : [],
                    );
                }
            } else {
                parsed.firedThresholds = {};
            }
            // Migration: if old struct exists, discard it (backward compat not required)
            if (!parsed.dailyTokens) parsed.dailyTokens = {};
            if (!parsed.monthlyTokens) parsed.monthlyTokens = {};

            return parsed;
        } catch {
            return ensureRecord();
        }
    }

    private saveTimeout: ReturnType<typeof setTimeout> | null = null;

    private scheduleSave(): void {
        if (!this.filePath || this.saveTimeout) {
            return;
        }
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            this.saveNow();
        }, 2000);
    }

    private saveNow(): void {
        if (!this.filePath || !this.dirty) {
            return;
        }
        try {
            const dir = path.dirname(this.filePath);
            fs.mkdirSync(dir, { recursive: true });
            // Serialize Sets as arrays for JSON.
            const serializable = {
                ...this.record,
                firedThresholds: Object.fromEntries(
                    Object.entries(this.record.firedThresholds).map(([k, v]) => [
                        k,
                        [...v],
                    ]),
                ),
            };
            fs.writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
            this.dirty = false;
        } catch {
            // Best-effort persistence — don't crash the gateway.
        }
    }

    /** Flush pending writes (for graceful shutdown). */
    flush(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        this.saveNow();
    }
}
