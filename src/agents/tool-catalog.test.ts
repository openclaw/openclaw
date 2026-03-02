/**
 * tool-catalog.test.ts
 *
 * [목적]
 * CORE_TOOL_DEFINITIONS에 task/milestone 도구가 올바르게 등록되어 있는지 검증한다.
 *
 * [배경]
 * openclaw.json의 tools.allow에 "group:task", "group:milestone"을 지정하면
 * expandToolGroups()가 이를 개별 tool ID로 확장해야 한다.
 * 이전에 CORE_TOOL_DEFINITIONS에 task/milestone 도구가 누락되어 있어서
 * group:task/group:milestone이 확장되지 않고 리터럴 문자열로 남아,
 * 모든 task/milestone 도구가 조용히 차단되는 프로덕션 버그가 있었다.
 *
 * [upstream merge 시 주의]
 * - CORE_TOOL_DEFINITIONS에 새 도구를 추가하면 EXPECTED_*_TOOL_IDS도 업데이트 필요
 * - tool-policy-shared.ts의 TOOL_GROUPS 구조가 변경되면 이 테스트도 수정 필요
 * - expandToolGroups의 시그니처나 동작이 변경되면 regression 테스트 확인 필요
 */
import { describe, expect, it } from "vitest";
import {
  isKnownCoreToolId,
  listCoreToolSections,
  resolveCoreToolProfilePolicy,
  resolveCoreToolProfiles,
} from "./tool-catalog.js";
import { expandToolGroups, TOOL_GROUPS } from "./tool-policy-shared.js";

// openclaw-tools.ts에서 런타임에 등록하는 도구 ID 목록.
// CORE_TOOL_DEFINITIONS에 반드시 포함되어야 group:task / group:milestone 확장이 동작한다.
const EXPECTED_TASK_TOOL_IDS = [
  "task_start",
  "task_update",
  "task_complete",
  "task_status",
  "task_list",
  "task_cancel",
  "task_approve",
  "task_block",
  "task_resume",
  "task_backlog_add",
  "task_pick_backlog",
  "task_verify",
];

const EXPECTED_MILESTONE_TOOL_IDS = [
  "milestone_list",
  "milestone_create",
  "milestone_add_item",
  "milestone_assign_item",
  "milestone_update_item",
];

// group:task가 TOOL_GROUPS에 존재하고, 모든 task 도구로 올바르게 확장되는지 검증
describe("tool-catalog: group:task", () => {
  it("group:task exists in TOOL_GROUPS", () => {
    expect(TOOL_GROUPS["group:task"]).toBeDefined();
  });

  it("group:task contains all expected task tool IDs", () => {
    const group = TOOL_GROUPS["group:task"];
    for (const id of EXPECTED_TASK_TOOL_IDS) {
      expect(group, `missing tool: ${id}`).toContain(id);
    }
  });

  it("expandToolGroups resolves group:task to individual tool IDs", () => {
    const expanded = expandToolGroups(["group:task"]);
    for (const id of EXPECTED_TASK_TOOL_IDS) {
      expect(expanded, `group:task did not expand to include ${id}`).toContain(id);
    }
    // Should not contain the literal "group:task" string
    expect(expanded).not.toContain("group:task");
  });

  it("all task tools are known core tool IDs", () => {
    for (const id of EXPECTED_TASK_TOOL_IDS) {
      expect(isKnownCoreToolId(id), `${id} not in CORE_TOOL_DEFINITIONS`).toBe(true);
    }
  });
});

// group:milestone이 TOOL_GROUPS에 존재하고, 모든 milestone 도구로 올바르게 확장되는지 검증
describe("tool-catalog: group:milestone", () => {
  it("group:milestone exists in TOOL_GROUPS", () => {
    expect(TOOL_GROUPS["group:milestone"]).toBeDefined();
  });

  it("group:milestone contains all expected milestone tool IDs", () => {
    const group = TOOL_GROUPS["group:milestone"];
    for (const id of EXPECTED_MILESTONE_TOOL_IDS) {
      expect(group, `missing tool: ${id}`).toContain(id);
    }
  });

  it("expandToolGroups resolves group:milestone to individual tool IDs", () => {
    const expanded = expandToolGroups(["group:milestone"]);
    for (const id of EXPECTED_MILESTONE_TOOL_IDS) {
      expect(expanded, `group:milestone did not expand to include ${id}`).toContain(id);
    }
    expect(expanded).not.toContain("group:milestone");
  });

  it("all milestone tools are known core tool IDs", () => {
    for (const id of EXPECTED_MILESTONE_TOOL_IDS) {
      expect(isKnownCoreToolId(id), `${id} not in CORE_TOOL_DEFINITIONS`).toBe(true);
    }
  });
});

// group:openclaw은 모든 커스텀 도구를 포함하는 상위 그룹 — task와 milestone도 포함되어야 함
describe("tool-catalog: group:openclaw includes task and milestone tools", () => {
  it("group:openclaw contains all task tools", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    for (const id of EXPECTED_TASK_TOOL_IDS) {
      expect(group, `group:openclaw missing task tool: ${id}`).toContain(id);
    }
  });

  it("group:openclaw contains all milestone tools", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    for (const id of EXPECTED_MILESTONE_TOOL_IDS) {
      expect(group, `group:openclaw missing milestone tool: ${id}`).toContain(id);
    }
  });
});

// listCoreToolSections()가 task/milestone 섹션을 포함하는지 검증
// UI나 도움말 출력에서 사용됨
describe("tool-catalog: sections", () => {
  it("listCoreToolSections includes task section", () => {
    const sections = listCoreToolSections();
    const taskSection = sections.find((s) => s.id === "task");
    expect(taskSection).toBeDefined();
    expect(taskSection!.label).toBe("Task Management");
    expect(taskSection!.tools.length).toBeGreaterThanOrEqual(EXPECTED_TASK_TOOL_IDS.length);
  });

  it("listCoreToolSections includes milestone section", () => {
    const sections = listCoreToolSections();
    const milestoneSection = sections.find((s) => s.id === "milestone");
    expect(milestoneSection).toBeDefined();
    expect(milestoneSection!.label).toBe("Milestones");
    expect(milestoneSection!.tools.length).toBeGreaterThanOrEqual(
      EXPECTED_MILESTONE_TOOL_IDS.length,
    );
  });
});

// [회귀 테스트] 실제 프로덕션 버그 재현:
// openclaw.json tools.allow에 group:task/group:milestone이 있을 때
// expandToolGroups → filterToolsByPolicy 파이프라인에서 올바르게 확장되어야 함
describe("tool-catalog: policy pipeline regression", () => {
  // Regression test for the exact bug fixed in this session:
  // When openclaw.json tools.allow contains ["read", "write", ..., "group:task", "group:milestone"],
  // expandToolGroups must resolve group:task/group:milestone to actual tool IDs.
  // Previously these groups were not in CORE_TOOL_DEFINITIONS, so they passed through
  // as literal strings and never matched any tool — silently blocking all task/milestone tools.

  it("expandToolGroups resolves a real-world allowlist without leftover group: literals", () => {
    const realWorldAllowlist = [
      "read",
      "write",
      "edit",
      "exec",
      "web_search",
      "web_fetch",
      "message",
      "group:sessions",
      "group:task",
      "group:milestone",
    ];
    const expanded = expandToolGroups(realWorldAllowlist);

    // group:task / group:milestone must NOT remain as literal strings
    const leftoverGroups = expanded.filter((e) => e.startsWith("group:"));
    expect(leftoverGroups, "group: literals should be fully expanded").toEqual([]);

    // Core tools must be present
    expect(expanded).toContain("read");
    expect(expanded).toContain("exec");

    // Task tools must be present
    expect(expanded).toContain("task_start");
    expect(expanded).toContain("task_complete");
    expect(expanded).toContain("task_list");

    // Milestone tools must be present
    expect(expanded).toContain("milestone_list");
    expect(expanded).toContain("milestone_create");

    // Session tools must be present (group:sessions)
    expect(expanded).toContain("sessions_list");
    expect(expanded).toContain("sessions_send");
  });

  it("task tools pass through filterToolsByPolicy when group:task is in allowlist", async () => {
    // Dynamically import to avoid pulling in heavy dependencies at module level
    const { filterToolsByPolicy } = await import("./pi-tools.policy.js");
    const allowlist = expandToolGroups(["read", "group:task"]);
    const tools = [
      { name: "read" },
      { name: "task_start" },
      { name: "task_complete" },
      { name: "browser" },
    ];
    // oxlint-disable-next-line typescript/no-explicit-any
    const filtered = filterToolsByPolicy(tools as any, { allow: allowlist });
    const names = filtered.map((t) => (t as unknown as { name: string }).name);
    expect(names).toContain("read");
    expect(names).toContain("task_start");
    expect(names).toContain("task_complete");
    expect(names).not.toContain("browser");
  });

  it("milestone tools pass through filterToolsByPolicy when group:milestone is in allowlist", async () => {
    const { filterToolsByPolicy } = await import("./pi-tools.policy.js");
    const allowlist = expandToolGroups(["read", "group:milestone"]);
    const tools = [
      { name: "read" },
      { name: "milestone_list" },
      { name: "milestone_create" },
      { name: "browser" },
    ];
    // oxlint-disable-next-line typescript/no-explicit-any
    const filtered = filterToolsByPolicy(tools as any, { allow: allowlist });
    const names = filtered.map((t) => (t as unknown as { name: string }).name);
    expect(names).toContain("read");
    expect(names).toContain("milestone_list");
    expect(names).toContain("milestone_create");
    expect(names).not.toContain("browser");
  });
});

// task/milestone 도구는 제한된 프로필(coding, minimal, messaging)에 포함되지 않아야 함
// 이 도구들은 full 모드에서만 사용 가능해야 한다
describe("tool-catalog: task/milestone tools are NOT in restrictive profiles", () => {
  it("task tools have empty profiles (available in full mode only)", () => {
    for (const id of EXPECTED_TASK_TOOL_IDS) {
      const profiles = resolveCoreToolProfiles(id);
      expect(profiles, `${id} should not be in any restrictive profile`).toEqual([]);
    }
  });

  it("milestone tools have empty profiles (available in full mode only)", () => {
    for (const id of EXPECTED_MILESTONE_TOOL_IDS) {
      const profiles = resolveCoreToolProfiles(id);
      expect(profiles, `${id} should not be in any restrictive profile`).toEqual([]);
    }
  });

  it("coding profile does not include task/milestone tools", () => {
    const coding = resolveCoreToolProfilePolicy("coding");
    expect(coding?.allow).toBeDefined();
    for (const id of [...EXPECTED_TASK_TOOL_IDS, ...EXPECTED_MILESTONE_TOOL_IDS]) {
      expect(coding!.allow, `coding profile should not include ${id}`).not.toContain(id);
    }
  });
});
