/**
 * tool-policy-pipeline.test.ts
 *
 * [목적]
 * applyToolPolicyPipeline()의 동작을 검증한다.
 * 이 함수는 openclaw.json의 tools.allow 설정을 실제 도구 필터링에 적용하는 핵심 파이프라인이다.
 *
 * [배경]
 * 도구 정책 파이프라인은 다음 순서로 동작:
 * 1. allowlist의 group:* 접두사를 개별 도구 ID로 확장 (expandToolGroups)
 * 2. plugin-only allowlist를 감지하여 코어 도구 차단 방지
 * 3. 알 수 없는 항목에 대해 경고 생성
 * 4. 최종 필터링으로 허용된 도구만 반환
 *
 * [upstream merge 시 주의]
 * - applyToolPolicyPipeline 시그니처 변경 시 모든 테스트 업데이트 필요
 * - stripPluginOnlyAllowlist 로직 변경 시 첫 번째 테스트 확인
 * - group:task/group:milestone 회귀 테스트는 반드시 유지 — 프로덕션 버그 방지
 */
import { describe, expect, test } from "vitest";
import { applyToolPolicyPipeline } from "./tool-policy-pipeline.js";

type DummyTool = { name: string };

describe("tool-policy-pipeline", () => {
  // plugin-only allowlist일 때 코어 도구가 차단되지 않도록 strip 처리되는지 검증
  test("strips allowlists that would otherwise disable core tools", () => {
    const tools = [{ name: "exec" }, { name: "plugin_tool" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: (t: any) => (t.name === "plugin_tool" ? { pluginId: "foo" } : undefined),
      warn: () => {},
      steps: [
        {
          policy: { allow: ["plugin_tool"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name).toSorted();
    expect(names).toEqual(["exec", "plugin_tool"]);
  });

  // allowlist에 존재하지 않는 도구가 있으면 경고 메시지가 생성되는지 검증
  test("warns about unknown allowlist entries", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["wat"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (wat)");
  });

  // 코어 도구가 명시적으로 나열된 경우 허용 목록에 없는 도구는 필터링되는지 검증
  test("applies allowlist filtering when core tools are explicitly listed", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });

  // ── [회귀 테스트] group:task / group:milestone 파이프라인 확장 ──
  // 프로덕션에서 agents의 tools.allow = ["read", "write", ..., "group:task", "group:milestone"]
  // 설정이 있었는데, CORE_TOOL_DEFINITIONS에 task/milestone이 누락되어
  // group:task/group:milestone이 확장되지 않고 리터럴 문자열로 남아
  // 모든 task/milestone 도구가 조용히 차단되었던 버그를 재현한다.

  // group:task가 allowlist에 있을 때 "unknown entries" 경고가 발생하지 않아야 함
  test("group:task in allowlist does NOT produce unknown-entry warnings", () => {
    const warnings: string[] = [];
    const tools = [
      { name: "read" },
      { name: "task_start" },
      { name: "task_list" },
    ] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["read", "group:task"] },
          label: "agents.ruda.tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const taskWarnings = warnings.filter((w) => w.includes("group:task"));
    expect(taskWarnings, "group:task should not trigger unknown-entry warning").toEqual([]);
  });

  // group:milestone도 마찬가지로 경고 없이 정상 확장되어야 함
  test("group:milestone in allowlist does NOT produce unknown-entry warnings", () => {
    const warnings: string[] = [];
    const tools = [
      { name: "read" },
      { name: "milestone_list" },
      { name: "milestone_create" },
    ] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["read", "group:milestone"] },
          label: "agents.ruda.tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const milestoneWarnings = warnings.filter((w) => w.includes("group:milestone"));
    expect(milestoneWarnings, "group:milestone should not trigger unknown-entry warning").toEqual(
      [],
    );
  });

  // group:task + 코어 도구를 함께 허용할 때, task 도구들이 필터링되지 않고 유지되는지 검증
  test("task tools are retained when group:task is in allowlist alongside core tools", () => {
    const tools = [
      { name: "read" },
      { name: "write" },
      { name: "task_start" },
      { name: "task_complete" },
      { name: "task_list" },
      { name: "browser" },
    ] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["read", "write", "group:task"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name).toSorted();
    expect(names).toContain("read");
    expect(names).toContain("task_start");
    expect(names).toContain("task_complete");
    expect(names).toContain("task_list");
    expect(names).not.toContain("browser");
  });

  // group:milestone + 코어 도구를 함께 허용할 때, milestone 도구들이 유지되는지 검증
  test("milestone tools are retained when group:milestone is in allowlist alongside core tools", () => {
    const tools = [
      { name: "read" },
      { name: "milestone_list" },
      { name: "milestone_create" },
      { name: "browser" },
    ] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      // oxlint-disable-next-line typescript/no-explicit-any
      tools: tools as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["read", "group:milestone"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name).toSorted();
    expect(names).toContain("read");
    expect(names).toContain("milestone_list");
    expect(names).toContain("milestone_create");
    expect(names).not.toContain("browser");
  });
});
