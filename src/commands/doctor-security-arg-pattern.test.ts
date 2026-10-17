import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runSecurityHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import { loadExecApprovals, readExecApprovalsSnapshot } from "../infra/exec-approvals-store.js";
import {
  saveExecApprovals,
  testing as execApprovalsStoreTesting,
} from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

const note = vi.hoisted(() => vi.fn());

// mock-isolation: Doctor argPattern repair asserts persisted approvals, not the terminal note renderer.
vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

describe("doctor security exec argPattern repair", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    execApprovalsStoreTesting.reset();
  });

  async function withExecApprovalsFile(
    file: Record<string, unknown>,
    run: () => Promise<void>,
  ): Promise<void> {
    await withTestDir({ prefix: "openclaw-doctor-arg-pattern-" }, async (home) => {
      process.env.HOME = home;
      process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
      closeOpenClawStateDatabaseForTest();
      execApprovalsStoreTesting.reset();
      saveExecApprovals(file as ExecApprovalsFile);
      try {
        await run();
      } finally {
        closeOpenClawStateDatabaseForTest();
        execApprovalsStoreTesting.reset();
      }
    });
  }

  it("detects rejected exec argPatterns without creating shared approval state", async () => {
    const { collectRejectedExecArgPatterns } = await import("./doctor-security.js");
    await withTestDir({ prefix: "openclaw-doctor-readonly-detect-" }, async (home) => {
      process.env.HOME = home;
      process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
      closeOpenClawStateDatabaseForTest();
      execApprovalsStoreTesting.reset();
      try {
        const statePath = resolveOpenClawStateSqlitePath();
        expect(statePath.startsWith(home)).toBe(true);
        expect(collectRejectedExecArgPatterns()).toEqual([]);
        expect(fsSync.existsSync(statePath)).toBe(false);
      } finally {
        closeOpenClawStateDatabaseForTest();
        execApprovalsStoreTesting.reset();
      }
    });
  });

  it("diagnoses rejected exec argPatterns without mutating persisted approvals", async () => {
    const approvals = {
      version: 1,
      agents: {
        main: {
          allowlist: [
            { pattern: "/usr/bin/python3", argPattern: "(a+)+$" },
            { pattern: "/usr/bin/ruby", argPattern: "^(a|a)+$" },
            { pattern: "/usr/bin/perl", argPattern: "^(aa|a.)+$" },
            { pattern: "/usr/bin/node", argPattern: "[invalid" },
            { pattern: "/bin/echo", argPattern: "^safe$" },
            { pattern: "/bin/escaped-space", argPattern: String.raw`\ ` },
            { pattern: "/bin/blank", argPattern: "" },
            { pattern: "/bin/space", argPattern: " " },
            { pattern: "/bin/path-only" },
          ],
        },
      },
    } satisfies ExecApprovalsFile;

    await withExecApprovalsFile(approvals, async () => {
      const beforeHash = readExecApprovalsSnapshot().hash;
      const lines: string[] = [];
      await runSecurityHealth({
        runtime: {
          log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
          error: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
          exit() {},
        },
        options: {},
        prompter: { shouldRepair: false },
        configResult: { cfg: {} },
        cfg: {},
        cfgForPersistence: {},
        sourceConfigValid: true,
        configPath: path.join(process.cwd(), "openclaw.json"),
      } as unknown as DoctorHealthFlowContext);

      const message = lines.join("\n");
      expect(message).toContain("unsafe-nested-repetition");
      expect(message).toContain("invalid-regex");
      expect(message).toContain("Remove the rejected entry");
      expect(readExecApprovalsSnapshot().hash).toBe(beforeHash);
    });
  });

  it("runs rejected argPattern repair through the Doctor security contribution", async () => {
    const approvals = {
      version: 1,
      agents: {
        main: {
          allowlist: [
            { pattern: "/bin/unsafe", argPattern: "(a+)+$" },
            { pattern: "/bin/safe", argPattern: "^safe$" },
          ],
        },
      },
    } satisfies ExecApprovalsFile;

    await withExecApprovalsFile(approvals, async () => {
      await runSecurityHealth({
        runtime: {
          log() {},
          error() {},
          exit() {},
        },
        options: { repair: true },
        prompter: { shouldRepair: true },
        configResult: { cfg: {} },
        cfg: {},
        cfgForPersistence: {},
        sourceConfigValid: true,
        configPath: path.join(process.cwd(), "openclaw.json"),
      } as unknown as DoctorHealthFlowContext);

      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("Removed 1 rejected exec approval entry"),
        "Doctor changes",
      );
      expect(loadExecApprovals().agents?.main?.allowlist).toEqual([
        expect.objectContaining({ pattern: "/bin/safe", argPattern: "^safe$" }),
      ]);
    });
  });

  it("repairs rejected exec argPatterns through the structured security health check", async () => {
    const collisionSafe = { pattern: "/bin/tool\0(a+)+$", argPattern: "safe" };
    const escapedWhitespace = {
      pattern: "/bin/escaped-space",
      argPattern: String.raw`\ `,
    };
    const approvals = {
      version: 1,
      agents: {
        main: {
          allowlist: [
            { pattern: "/bin/tool", argPattern: "(a+)+$\0safe" },
            { pattern: "/bin/invalid", argPattern: "[invalid" },
            { pattern: "/bin/overlap", argPattern: "^(a|a)+$" },
            { pattern: "/bin/equal-overlap", argPattern: "^(aa|a.)+$" },
            { pattern: "/bin/duplicate", argPattern: "(a+)+$" },
            { pattern: "/bin/duplicate", argPattern: "(a+)+$" },
            collisionSafe,
            escapedWhitespace,
            { pattern: "/bin/echo", argPattern: "^safe$" },
            { pattern: "/bin/blank", argPattern: "" },
            { pattern: "/bin/space", argPattern: " " },
            { pattern: "/bin/path-only" },
          ],
        },
      },
    } satisfies ExecApprovalsFile;

    await withExecApprovalsFile(approvals, async () => {
      const { CORE_HEALTH_CHECKS } = await import("../flows/doctor-core-checks.js");
      const check = CORE_HEALTH_CHECKS.find(
        (candidate) => candidate.id === "core/doctor/exec-approval-arg-patterns",
      );
      expect(check).toBeDefined();
      const context = {
        mode: "fix" as const,
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {} as OpenClawConfig,
      };
      const findings = await check!.detect(context);
      expect(findings).toHaveLength(6);
      const beforeHash = readExecApprovalsSnapshot().hash;

      const preview = await check!.repair?.({ ...context, dryRun: true }, findings);
      expect(preview?.changes).toEqual([
        expect.stringContaining("Would remove 6 rejected exec approval entries"),
      ]);
      expect(preview?.effects).toEqual([
        expect.objectContaining({
          kind: "state",
          action: "remove 6 rejected exec approval entries",
        }),
      ]);
      expect(readExecApprovalsSnapshot().hash).toBe(beforeHash);

      const repaired = await check!.repair?.(context, findings);
      expect(repaired?.changes).toEqual([
        expect.stringContaining("Removed 6 rejected exec approval entries"),
      ]);
      expect(repaired?.effects).toEqual([
        expect.objectContaining({
          kind: "state",
          action: "remove 6 rejected exec approval entries",
        }),
      ]);
      expect(await check!.detect(context)).toEqual([]);

      const remaining = loadExecApprovals().agents?.main?.allowlist ?? [];
      expect(remaining.map(({ pattern, argPattern }) => ({ pattern, argPattern }))).toEqual([
        collisionSafe,
        escapedWhitespace,
        { pattern: "/bin/echo", argPattern: "^safe$" },
        { pattern: "/bin/blank", argPattern: "" },
        { pattern: "/bin/space", argPattern: " " },
        { pattern: "/bin/path-only" },
      ]);
    });
  });

  it("preserves conservatively refused Unicode approvals during Doctor repair", async () => {
    const conservative = {
      pattern: "/usr/bin/printf",
      argPattern: "^(?:[猫]|[犬])+$",
    };
    const grouped = { pattern: "/bin/grouped", argPattern: "^(ab)*(cb)*$" };
    const approvals = {
      version: 1,
      agents: {
        main: {
          allowlist: [
            { pattern: "/bin/unsafe", argPattern: "(a+)+$" },
            conservative,
            grouped,
            { pattern: "/bin/safe", argPattern: "^safe$" },
          ],
        },
      },
    } satisfies ExecApprovalsFile;

    await withExecApprovalsFile(approvals, async () => {
      const { CORE_HEALTH_CHECKS } = await import("../flows/doctor-core-checks.js");
      const check = CORE_HEALTH_CHECKS.find(
        (candidate) => candidate.id === "core/doctor/exec-approval-arg-patterns",
      );
      expect(check).toBeDefined();
      const context = {
        mode: "fix" as const,
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {} as OpenClawConfig,
      };
      const findings = await check!.detect(context);
      expect(findings).toHaveLength(2);
      expect(findings.some((finding) => finding.message.includes("/bin/unsafe"))).toBe(true);
      expect(findings.some((finding) => finding.message.includes("conservatively refused"))).toBe(
        true,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/grouped"))).toBe(false);
      expect(
        findings.find((finding) => finding.message.includes("conservatively refused"))?.fixHint,
      ).toContain("keeps this stored rule");

      const repaired = await check!.repair?.(context, findings);
      expect(repaired?.changes).toEqual([
        expect.stringContaining("Removed 1 rejected exec approval entry"),
      ]);
      expect(repaired?.changes?.[0]).toContain("Kept 1 conservatively refused");
      expect(await check!.detect(context)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("conservatively refused"),
          }),
        ]),
      );

      const remaining = loadExecApprovals().agents?.main?.allowlist ?? [];
      expect(remaining.map(({ pattern, argPattern }) => ({ pattern, argPattern }))).toEqual([
        conservative,
        grouped,
        { pattern: "/bin/safe", argPattern: "^safe$" },
      ]);
    });
  });

  it("keeps long disjoint alternatives past the analysis atom cap and still removes nested repetition", async () => {
    const longDisjoint = {
      pattern: "/bin/long-disjoint",
      argPattern: `^([a]${"b".repeat(32)}|[c]${"d".repeat(32)})+$`,
    };
    const propertyIdentity = {
      pattern: "/bin/property-identity",
      argPattern: String.raw`^(\p{L}a|p\{L\}ap\{L\}a)+$`,
    };
    const eAcuteOverlap = {
      pattern: "/bin/e-acute",
      argPattern: String.raw`^(\u00E9a|[é]a)+$`,
    };
    const truncatedOverlap = {
      pattern: "/bin/truncated-overlap",
      argPattern: `^([a]${"a".repeat(32)}|[a]${"a".repeat(32)}[a]${"a".repeat(32)})+$`,
    };
    const seventeenWay = {
      pattern: "/bin/seventeen-way",
      argPattern: "^((a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)x|zx)+$",
    };
    const classOverflow = {
      pattern: "/bin/class-overflow",
      argPattern:
        "^(([a]a|[b]b|[c]c|[d]d|[e]e|[f]f|[g]g|[h]h|[i]i|[j]j|[k]k|[l]l|[m]m|[n]n|[o]o|[p]p|[q]q)|[z]z)+$",
    };
    const mixedTailUnit = `[a]${"ba".repeat(17)}`;
    const mixedTail = {
      pattern: "/bin/mixed-tail",
      argPattern: `^(${mixedTailUnit}|${mixedTailUnit}${mixedTailUnit})+$`,
    };
    const overflowPrefix = {
      pattern: "/bin/overflow-prefix",
      argPattern: "^((a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)x|axax)+$",
    };
    const twoCharOverflowPrefix = {
      pattern: "/bin/two-char-overflow",
      argPattern: "^((ax|bx|cx|dx|ex|fx|gx|hx|ix|jx|kx|lx|mx|nx|ox|px|qx)|axax)+$",
    };
    const truncatedDisjointPrefix = `[a]${"a".repeat(31)}`;
    const truncatedDisjoint = {
      pattern: "/bin/truncated-disjoint",
      argPattern: `^(${truncatedDisjointPrefix}b|${truncatedDisjointPrefix}c)+$`,
    };
    const longerTruncatedDisjointPrefix = `[a]${"a".repeat(32)}`;
    const longerTruncatedDisjoint = {
      pattern: "/bin/truncated-disjoint-32",
      argPattern: `^(${longerTruncatedDisjointPrefix}b|${longerTruncatedDisjointPrefix}c)+$`,
    };
    const macronOverlap = {
      pattern: "/bin/macron-overlap",
      argPattern: "^([Ā]a|ĀaĀa)+$",
    };
    const approvals = {
      version: 1,
      agents: {
        main: {
          allowlist: [
            { pattern: "/bin/unsafe", argPattern: "(a+)+$" },
            longDisjoint,
            propertyIdentity,
            eAcuteOverlap,
            truncatedOverlap,
            seventeenWay,
            classOverflow,
            mixedTail,
            overflowPrefix,
            twoCharOverflowPrefix,
            truncatedDisjoint,
            longerTruncatedDisjoint,
            macronOverlap,
            { pattern: "/bin/safe", argPattern: "^safe$" },
          ],
        },
      },
    } satisfies ExecApprovalsFile;

    await withExecApprovalsFile(approvals, async () => {
      const { CORE_HEALTH_CHECKS } = await import("../flows/doctor-core-checks.js");
      const check = CORE_HEALTH_CHECKS.find(
        (candidate) => candidate.id === "core/doctor/exec-approval-arg-patterns",
      );
      expect(check).toBeDefined();
      const context = {
        mode: "fix" as const,
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {} as OpenClawConfig,
      };
      const findings = await check!.detect(context);
      expect(findings).toHaveLength(9);
      expect(findings.some((finding) => finding.message.includes("/bin/unsafe"))).toBe(true);
      expect(findings.some((finding) => finding.message.includes("/bin/property-identity"))).toBe(
        true,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/e-acute"))).toBe(true);
      expect(findings.some((finding) => finding.message.includes("/bin/truncated-overlap"))).toBe(
        true,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/overflow-prefix"))).toBe(
        true,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/two-char-overflow"))).toBe(
        true,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/macron-overlap"))).toBe(
        true,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/long-disjoint"))).toBe(
        false,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/seventeen-way"))).toBe(
        false,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/class-overflow"))).toBe(
        false,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/mixed-tail"))).toBe(true);
      // Quoted so this does not also match /bin/truncated-disjoint-32.
      expect(
        findings.some((finding) => finding.message.includes('"/bin/truncated-disjoint"')),
      ).toBe(false);
      expect(
        findings.some(
          (finding) =>
            finding.message.includes("/bin/truncated-disjoint-32") &&
            finding.message.includes("conservatively refused"),
        ),
      ).toBe(true);

      const repaired = await check!.repair?.(context, findings);
      expect(repaired?.changes).toEqual([
        expect.stringContaining("Removed 8 rejected exec approval entries"),
      ]);
      expect(repaired?.changes?.[0]).toContain("Kept 1 conservatively refused rule");

      const remaining = loadExecApprovals().agents?.main?.allowlist ?? [];
      expect(remaining.map(({ pattern, argPattern }) => ({ pattern, argPattern }))).toEqual([
        longDisjoint,
        seventeenWay,
        classOverflow,
        truncatedDisjoint,
        longerTruncatedDisjoint,
        { pattern: "/bin/safe", argPattern: "^safe$" },
      ]);
    });
  });

  it("keeps disjoint mixed equal-length alternatives and still removes nested repetition", async () => {
    const mixed = { pattern: "/bin/mixed", argPattern: "^(ab|[c]d)+$" };
    const grouped = { pattern: "/bin/grouped", argPattern: "^((ab)|(cd))+$" };
    const nested = { pattern: "/bin/nested", argPattern: "^((ab|cd)e|(fg|hi)j)+$" };
    const unequal = { pattern: "/bin/unequal", argPattern: "^(a|[b]c)+$" };
    const escapedDot = { pattern: "/bin/escaped-dot", argPattern: String.raw`^(\.a|[b]a)+$` };
    const hexDollar = { pattern: "/bin/hex-dollar", argPattern: String.raw`^(\x24a|[$]a)+$` };
    const highOctal = { pattern: "/bin/high-octal", argPattern: String.raw`^(\400| 0)+$` };
    const escapedDollar = { pattern: "/bin/escaped-dollar", argPattern: String.raw`^(a\$|b[!])+$` };
    const twoDigitBackref = {
      pattern: "/bin/two-digit-backref",
      argPattern: `^${"()".repeat(39)}(a)(\\40b|abab)+$`,
    };
    const threeDigitBackref = {
      pattern: "/bin/three-digit-backref",
      argPattern: `^${"()".repeat(140)}(a)(\\141b|abab)+$`,
    };
    const approvals = {
      version: 1,
      agents: {
        main: {
          allowlist: [
            { pattern: "/bin/unsafe", argPattern: "(a+)+$" },
            mixed,
            grouped,
            nested,
            unequal,
            escapedDot,
            escapedDollar,
            hexDollar,
            highOctal,
            twoDigitBackref,
            threeDigitBackref,
            { pattern: "/bin/safe", argPattern: "^safe$" },
          ],
        },
      },
    } satisfies ExecApprovalsFile;

    await withExecApprovalsFile(approvals, async () => {
      const { CORE_HEALTH_CHECKS } = await import("../flows/doctor-core-checks.js");
      const check = CORE_HEALTH_CHECKS.find(
        (candidate) => candidate.id === "core/doctor/exec-approval-arg-patterns",
      );
      expect(check).toBeDefined();
      const context = {
        mode: "fix" as const,
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {} as OpenClawConfig,
      };
      const findings = await check!.detect(context);
      expect(findings).toHaveLength(5);
      expect(findings.some((finding) => finding.message.includes("/bin/unsafe"))).toBe(true);
      expect(findings.some((finding) => finding.message.includes("/bin/hex-dollar"))).toBe(true);
      expect(findings.some((finding) => finding.message.includes("/bin/high-octal"))).toBe(true);
      expect(findings.some((finding) => finding.message.includes("/bin/two-digit-backref"))).toBe(
        true,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/three-digit-backref"))).toBe(
        true,
      );
      expect(findings.some((finding) => finding.message.includes("/bin/mixed"))).toBe(false);
      expect(findings.some((finding) => finding.message.includes("/bin/grouped"))).toBe(false);
      expect(findings.some((finding) => finding.message.includes("/bin/nested"))).toBe(false);
      expect(findings.some((finding) => finding.message.includes("/bin/unequal"))).toBe(false);
      expect(findings.some((finding) => finding.message.includes("/bin/escaped-dot"))).toBe(false);
      expect(findings.some((finding) => finding.message.includes("/bin/escaped-dollar"))).toBe(
        false,
      );

      const repaired = await check!.repair?.(context, findings);
      expect(repaired?.changes).toEqual([
        expect.stringContaining("Removed 5 rejected exec approval entries"),
      ]);

      const remaining = loadExecApprovals().agents?.main?.allowlist ?? [];
      expect(remaining.map(({ pattern, argPattern }) => ({ pattern, argPattern }))).toEqual([
        mixed,
        grouped,
        nested,
        unequal,
        escapedDot,
        escapedDollar,
        { pattern: "/bin/safe", argPattern: "^safe$" },
      ]);
    });
  });
});
