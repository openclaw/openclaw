import path from "node:path";
import { DEFAULT_SAFE_BINS, analyzeShellCommand, isWindowsPlatform, matchAllowlist, resolveAllowlistCandidatePath, resolveCommandResolutionFromArgv, splitCommandChain, } from "./exec-approvals-analysis.js";
import { SAFE_BIN_PROFILES, validateSafeBinArgv, } from "./exec-safe-bin-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";
import { extractShellWrapperInlineCommand, isDispatchWrapperExecutable, isShellWrapperExecutable, unwrapKnownShellMultiplexerInvocation, unwrapKnownDispatchWrapperInvocation, } from "./exec-wrapper-resolution.js";
function hasShellLineContinuation(command) {
    return /\\(?:\r\n|\n|\r)/.test(command);
}
export function normalizeSafeBins(entries) {
    if (!Array.isArray(entries)) {
        return new Set();
    }
    const normalized = entries
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    return new Set(normalized);
}
export function resolveSafeBins(entries) {
    if (entries === undefined) {
        return normalizeSafeBins(DEFAULT_SAFE_BINS);
    }
    return normalizeSafeBins(entries ?? []);
}
export function isSafeBinUsage(params) {
    // Windows host exec uses PowerShell, which has different parsing/expansion rules.
    // Keep safeBins conservative there (require explicit allowlist entries).
    if (isWindowsPlatform(params.platform ?? process.platform)) {
        return false;
    }
    if (params.safeBins.size === 0) {
        return false;
    }
    const resolution = params.resolution;
    const execName = resolution?.executableName?.toLowerCase();
    if (!execName) {
        return false;
    }
    const matchesSafeBin = params.safeBins.has(execName);
    if (!matchesSafeBin) {
        return false;
    }
    if (!resolution?.resolvedPath) {
        return false;
    }
    const isTrustedPath = params.isTrustedSafeBinPathFn ?? isTrustedSafeBinPath;
    if (!isTrustedPath({
        resolvedPath: resolution.resolvedPath,
        trustedDirs: params.trustedSafeBinDirs,
    })) {
        return false;
    }
    const argv = params.argv.slice(1);
    const safeBinProfiles = params.safeBinProfiles ?? SAFE_BIN_PROFILES;
    const profile = safeBinProfiles[execName];
    if (!profile) {
        return false;
    }
    return validateSafeBinArgv(argv, profile);
}
function isPathScopedExecutableToken(token) {
    return token.includes("/") || token.includes("\\");
}
function normalizeSkillBinName(value) {
    const trimmed = value?.trim().toLowerCase();
    return trimmed && trimmed.length > 0 ? trimmed : null;
}
function normalizeSkillBinResolvedPath(value) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return null;
    }
    const resolved = path.resolve(trimmed);
    if (process.platform === "win32") {
        return resolved.replace(/\\/g, "/").toLowerCase();
    }
    return resolved;
}
function buildSkillBinTrustIndex(entries) {
    const trustByName = new Map();
    if (!entries || entries.length === 0) {
        return trustByName;
    }
    for (const entry of entries) {
        const name = normalizeSkillBinName(entry.name);
        const resolvedPath = normalizeSkillBinResolvedPath(entry.resolvedPath);
        if (!name || !resolvedPath) {
            continue;
        }
        const paths = trustByName.get(name) ?? new Set();
        paths.add(resolvedPath);
        trustByName.set(name, paths);
    }
    return trustByName;
}
function isSkillAutoAllowedSegment(params) {
    if (!params.allowSkills) {
        return false;
    }
    const resolution = params.segment.resolution;
    if (!resolution?.resolvedPath) {
        return false;
    }
    const rawExecutable = resolution.rawExecutable?.trim() ?? "";
    if (!rawExecutable || isPathScopedExecutableToken(rawExecutable)) {
        return false;
    }
    const executableName = normalizeSkillBinName(resolution.executableName);
    const resolvedPath = normalizeSkillBinResolvedPath(resolution.resolvedPath);
    if (!executableName || !resolvedPath) {
        return false;
    }
    return Boolean(params.skillBinTrust.get(executableName)?.has(resolvedPath));
}
function evaluateSegments(segments, params) {
    const matches = [];
    const skillBinTrust = buildSkillBinTrustIndex(params.skillBins);
    const allowSkills = params.autoAllowSkills === true && skillBinTrust.size > 0;
    const segmentSatisfiedBy = [];
    const satisfied = segments.every((segment) => {
        if (segment.resolution?.policyBlocked === true) {
            segmentSatisfiedBy.push(null);
            return false;
        }
        const effectiveArgv = segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0
            ? segment.resolution.effectiveArgv
            : segment.argv;
        const candidatePath = resolveAllowlistCandidatePath(segment.resolution, params.cwd);
        const candidateResolution = candidatePath && segment.resolution
            ? { ...segment.resolution, resolvedPath: candidatePath }
            : segment.resolution;
        const match = matchAllowlist(params.allowlist, candidateResolution);
        if (match) {
            matches.push(match);
        }
        const safe = isSafeBinUsage({
            argv: effectiveArgv,
            resolution: segment.resolution,
            safeBins: params.safeBins,
            safeBinProfiles: params.safeBinProfiles,
            platform: params.platform,
            trustedSafeBinDirs: params.trustedSafeBinDirs,
        });
        const skillAllow = isSkillAutoAllowedSegment({
            segment,
            allowSkills,
            skillBinTrust,
        });
        const by = match
            ? "allowlist"
            : safe
                ? "safeBins"
                : skillAllow
                    ? "skills"
                    : null;
        segmentSatisfiedBy.push(by);
        return Boolean(by);
    });
    return { satisfied, matches, segmentSatisfiedBy };
}
function resolveAnalysisSegmentGroups(analysis) {
    if (analysis.chains) {
        return analysis.chains;
    }
    return [analysis.segments];
}
export function evaluateExecAllowlist(params) {
    const allowlistMatches = [];
    const segmentSatisfiedBy = [];
    if (!params.analysis.ok || params.analysis.segments.length === 0) {
        return { allowlistSatisfied: false, allowlistMatches, segmentSatisfiedBy };
    }
    const hasChains = Boolean(params.analysis.chains);
    for (const group of resolveAnalysisSegmentGroups(params.analysis)) {
        const result = evaluateSegments(group, {
            allowlist: params.allowlist,
            safeBins: params.safeBins,
            safeBinProfiles: params.safeBinProfiles,
            cwd: params.cwd,
            platform: params.platform,
            trustedSafeBinDirs: params.trustedSafeBinDirs,
            skillBins: params.skillBins,
            autoAllowSkills: params.autoAllowSkills,
        });
        if (!result.satisfied) {
            if (!hasChains) {
                return {
                    allowlistSatisfied: false,
                    allowlistMatches: result.matches,
                    segmentSatisfiedBy: result.segmentSatisfiedBy,
                };
            }
            return { allowlistSatisfied: false, allowlistMatches: [], segmentSatisfiedBy: [] };
        }
        allowlistMatches.push(...result.matches);
        segmentSatisfiedBy.push(...result.segmentSatisfiedBy);
    }
    return { allowlistSatisfied: true, allowlistMatches, segmentSatisfiedBy };
}
function hasSegmentExecutableMatch(segment, predicate) {
    const candidates = [
        segment.resolution?.executableName,
        segment.resolution?.rawExecutable,
        segment.argv[0],
    ];
    for (const candidate of candidates) {
        const trimmed = candidate?.trim();
        if (!trimmed) {
            continue;
        }
        if (predicate(trimmed)) {
            return true;
        }
    }
    return false;
}
function isShellWrapperSegment(segment) {
    return hasSegmentExecutableMatch(segment, isShellWrapperExecutable);
}
function isDispatchWrapperSegment(segment) {
    return hasSegmentExecutableMatch(segment, isDispatchWrapperExecutable);
}
function collectAllowAlwaysPatterns(params) {
    if (params.depth >= 3) {
        return;
    }
    if (isDispatchWrapperSegment(params.segment)) {
        const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(params.segment.argv);
        if (dispatchUnwrap.kind !== "unwrapped" || dispatchUnwrap.argv.length === 0) {
            return;
        }
        collectAllowAlwaysPatterns({
            segment: {
                raw: dispatchUnwrap.argv.join(" "),
                argv: dispatchUnwrap.argv,
                resolution: resolveCommandResolutionFromArgv(dispatchUnwrap.argv, params.cwd, params.env),
            },
            cwd: params.cwd,
            env: params.env,
            platform: params.platform,
            depth: params.depth + 1,
            out: params.out,
        });
        return;
    }
    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(params.segment.argv);
    if (shellMultiplexerUnwrap.kind === "blocked") {
        return;
    }
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
        collectAllowAlwaysPatterns({
            segment: {
                raw: shellMultiplexerUnwrap.argv.join(" "),
                argv: shellMultiplexerUnwrap.argv,
                resolution: resolveCommandResolutionFromArgv(shellMultiplexerUnwrap.argv, params.cwd, params.env),
            },
            cwd: params.cwd,
            env: params.env,
            platform: params.platform,
            depth: params.depth + 1,
            out: params.out,
        });
        return;
    }
    const candidatePath = resolveAllowlistCandidatePath(params.segment.resolution, params.cwd);
    if (!candidatePath) {
        return;
    }
    if (!isShellWrapperSegment(params.segment)) {
        params.out.add(candidatePath);
        return;
    }
    const inlineCommand = extractShellWrapperInlineCommand(params.segment.argv);
    if (!inlineCommand) {
        return;
    }
    const nested = analyzeShellCommand({
        command: inlineCommand,
        cwd: params.cwd,
        env: params.env,
        platform: params.platform,
    });
    if (!nested.ok) {
        return;
    }
    for (const nestedSegment of nested.segments) {
        collectAllowAlwaysPatterns({
            segment: nestedSegment,
            cwd: params.cwd,
            env: params.env,
            platform: params.platform,
            depth: params.depth + 1,
            out: params.out,
        });
    }
}
/**
 * Derive persisted allowlist patterns for an "allow always" decision.
 * When a command is wrapped in a shell (for example `zsh -lc "<cmd>"`),
 * persist the inner executable(s) rather than the shell binary.
 */
export function resolveAllowAlwaysPatterns(params) {
    const patterns = new Set();
    for (const segment of params.segments) {
        collectAllowAlwaysPatterns({
            segment,
            cwd: params.cwd,
            env: params.env,
            platform: params.platform,
            depth: 0,
            out: patterns,
        });
    }
    return Array.from(patterns);
}
/**
 * Evaluates allowlist for shell commands (including &&, ||, ;) and returns analysis metadata.
 */
export function evaluateShellAllowlist(params) {
    const analysisFailure = () => ({
        analysisOk: false,
        allowlistSatisfied: false,
        allowlistMatches: [],
        segments: [],
        segmentSatisfiedBy: [],
    });
    // Keep allowlist analysis conservative: line-continuation semantics are shell-dependent
    // and can rewrite token boundaries at runtime.
    if (hasShellLineContinuation(params.command)) {
        return analysisFailure();
    }
    const chainParts = isWindowsPlatform(params.platform) ? null : splitCommandChain(params.command);
    if (!chainParts) {
        const analysis = analyzeShellCommand({
            command: params.command,
            cwd: params.cwd,
            env: params.env,
            platform: params.platform,
        });
        if (!analysis.ok) {
            return analysisFailure();
        }
        const evaluation = evaluateExecAllowlist({
            analysis,
            allowlist: params.allowlist,
            safeBins: params.safeBins,
            safeBinProfiles: params.safeBinProfiles,
            cwd: params.cwd,
            platform: params.platform,
            trustedSafeBinDirs: params.trustedSafeBinDirs,
            skillBins: params.skillBins,
            autoAllowSkills: params.autoAllowSkills,
        });
        return {
            analysisOk: true,
            allowlistSatisfied: evaluation.allowlistSatisfied,
            allowlistMatches: evaluation.allowlistMatches,
            segments: analysis.segments,
            segmentSatisfiedBy: evaluation.segmentSatisfiedBy,
        };
    }
    const allowlistMatches = [];
    const segments = [];
    const segmentSatisfiedBy = [];
    for (const part of chainParts) {
        const analysis = analyzeShellCommand({
            command: part,
            cwd: params.cwd,
            env: params.env,
            platform: params.platform,
        });
        if (!analysis.ok) {
            return analysisFailure();
        }
        segments.push(...analysis.segments);
        const evaluation = evaluateExecAllowlist({
            analysis,
            allowlist: params.allowlist,
            safeBins: params.safeBins,
            safeBinProfiles: params.safeBinProfiles,
            cwd: params.cwd,
            platform: params.platform,
            trustedSafeBinDirs: params.trustedSafeBinDirs,
            skillBins: params.skillBins,
            autoAllowSkills: params.autoAllowSkills,
        });
        allowlistMatches.push(...evaluation.allowlistMatches);
        segmentSatisfiedBy.push(...evaluation.segmentSatisfiedBy);
        if (!evaluation.allowlistSatisfied) {
            return {
                analysisOk: true,
                allowlistSatisfied: false,
                allowlistMatches,
                segments,
                segmentSatisfiedBy,
            };
        }
    }
    return {
        analysisOk: true,
        allowlistSatisfied: true,
        allowlistMatches,
        segments,
        segmentSatisfiedBy,
    };
}
