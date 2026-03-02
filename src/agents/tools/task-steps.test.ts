/**
 * task-steps.test.ts
 *
 * [목적]
 * summarizeStepCounts()의 동작을 검증한다.
 * 태스크의 steps 배열에서 각 상태(done, in_progress, pending, skipped)별 개수를 집계한다.
 *
 * [배경]
 * 에이전트가 태스크 진행 상황을 보고할 때 사용하는 유틸리티 함수.
 * steps가 없거나 빈 배열이면 undefined를 반환하여 "단계 없음"을 표현한다.
 *
 * [upstream merge 시 주의]
 * - TaskFile 인터페이스에 필드가 추가/변경되면 makeTask 헬퍼 업데이트 필요
 * - TaskStepStatus에 새 상태가 추가되면 해당 카운트 테스트 추가 필요
 * - summarizeStepCounts 반환 타입이 변경되면 toEqual 기대값 수정 필요
 */
import { describe, expect, it } from "vitest";
import type { TaskFile } from "./task-file-io.js";
import { summarizeStepCounts } from "./task-steps.js";

// TaskFile 목 생성 헬퍼 — steps 외의 필드는 테스트에 무관하므로 최소값만 설정
function makeTask(steps?: Array<{ status: string }>): TaskFile {
  return {
    id: "test-task",
    status: "in_progress",
    priority: "medium",
    description: "test",
    created: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    progress: [],
    workSessionId: "ws-1",
    steps: steps as TaskFile["steps"],
  } as TaskFile;
}

describe("summarizeStepCounts", () => {
  // steps가 없으면 집계할 것이 없으므로 undefined
  it("returns undefined when task has no steps", () => {
    expect(summarizeStepCounts(makeTask())).toBeUndefined();
  });

  it("returns undefined when steps is empty array", () => {
    expect(summarizeStepCounts(makeTask([]))).toBeUndefined();
  });

  // 혼합 상태의 steps — 모든 상태가 올바르게 카운트되는지 검증
  it("counts all step statuses correctly", () => {
    const steps = [
      { status: "done" },
      { status: "done" },
      { status: "in_progress" },
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
      { status: "skipped" },
    ];
    const result = summarizeStepCounts(makeTask(steps));
    expect(result).toEqual({
      totalSteps: 7,
      done: 2,
      inProgress: 1,
      pending: 3,
      skipped: 1,
    });
  });

  // 모든 단계 완료 — done 이외의 카운트는 0이어야 함
  it("handles all done", () => {
    const steps = [{ status: "done" }, { status: "done" }];
    const result = summarizeStepCounts(makeTask(steps));
    expect(result).toEqual({
      totalSteps: 2,
      done: 2,
      inProgress: 0,
      pending: 0,
      skipped: 0,
    });
  });

  // 단일 단계 — 최소 케이스
  it("handles single step", () => {
    const result = summarizeStepCounts(makeTask([{ status: "pending" }]));
    expect(result).toEqual({
      totalSteps: 1,
      done: 0,
      inProgress: 0,
      pending: 1,
      skipped: 0,
    });
  });
});
