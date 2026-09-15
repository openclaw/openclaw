import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runSecurityHealth } from "../flows/doctor-health-contribution-runners.gateway.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import {
  loadExecApprovals,
  readExecApprovalsSnapshot,
  saveExecApprovals,
} from "../infra/exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

const note = vi.hoisted(() => vi.fn());

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
});
