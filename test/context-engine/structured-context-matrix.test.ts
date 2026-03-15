import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type MatrixCase = {
  id: string;
  lengthBucket: "S" | "M" | "L" | "XL";
  turnCount: number;
  taskType: "code_debugging" | "research" | "operations" | "writing_planning" | "mixed_tool_dense";
  dialogueForm:
    | "linear_qa"
    | "clarification_branch"
    | "interruption_resume"
    | "goal_redirect"
    | "conflicting_instruction_fix";
  seed: number;
  taskId: string;
  taskObjective: string;
  acceptanceChecks: string[];
};

type TaskDefinition = {
  taskId: string;
  taskType: MatrixCase["taskType"];
  title: string;
  objective: string;
  inputArtifacts: string[];
  hardConstraints: string[];
  deliverables: string[];
  primaryIdentifiers: string[];
  toolProfile: "light" | "mixed_dense";
};

function loadMatrixCases(): MatrixCase[] {
  const filePath = path.join(
    process.cwd(),
    "test",
    "context-engine",
    "structured-context-matrix",
    "cases.json",
  );
  return JSON.parse(readFileSync(filePath, "utf8")) as MatrixCase[];
}

function loadTaskDefinitions(): TaskDefinition[] {
  const filePath = path.join(
    process.cwd(),
    "test",
    "context-engine",
    "structured-context-matrix",
    "tasks.json",
  );
  return JSON.parse(readFileSync(filePath, "utf8")) as TaskDefinition[];
}

describe("structured-context matrix coverage", () => {
  it("keeps exactly 30 fixed samples", () => {
    const cases = loadMatrixCases();
    expect(cases).toHaveLength(30);
  });

  it("covers each task type x dialogue form at least once with M/L cases", () => {
    const cases = loadMatrixCases();
    const qualifying = new Set(
      cases
        .filter((item) => item.lengthBucket === "M" || item.lengthBucket === "L")
        .map((item) => `${item.taskType}::${item.dialogueForm}`),
    );

    const taskTypes: MatrixCase["taskType"][] = [
      "code_debugging",
      "research",
      "operations",
      "writing_planning",
      "mixed_tool_dense",
    ];
    const dialogueForms: MatrixCase["dialogueForm"][] = [
      "linear_qa",
      "clarification_branch",
      "interruption_resume",
      "goal_redirect",
      "conflicting_instruction_fix",
    ];

    for (const taskType of taskTypes) {
      for (const dialogueForm of dialogueForms) {
        expect(qualifying.has(`${taskType}::${dialogueForm}`)).toBe(true);
      }
    }
  });

  it("keeps boundary buckets represented by S and XL", () => {
    const cases = loadMatrixCases();
    const buckets = new Set(cases.map((item) => item.lengthBucket));
    expect(buckets.has("S")).toBe(true);
    expect(buckets.has("XL")).toBe(true);
  });

  it("binds every case to a concrete task and non-empty acceptance checks", () => {
    const cases = loadMatrixCases();
    for (const item of cases) {
      expect(item.taskId.length).toBeGreaterThan(0);
      expect(item.taskObjective.trim().length).toBeGreaterThan(0);
      expect(item.acceptanceChecks.length).toBeGreaterThanOrEqual(3);
      for (const check of item.acceptanceChecks) {
        expect(check.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("structured-context task catalog integrity", () => {
  it("keeps unique task IDs with required execution fields", () => {
    const tasks = loadTaskDefinitions();
    const ids = new Set<string>();
    for (const task of tasks) {
      expect(ids.has(task.taskId)).toBe(false);
      ids.add(task.taskId);

      expect(task.title.trim().length).toBeGreaterThan(0);
      expect(task.objective.trim().length).toBeGreaterThan(0);
      expect(task.inputArtifacts.length).toBeGreaterThan(0);
      expect(task.hardConstraints.length).toBeGreaterThan(0);
      expect(task.deliverables.length).toBeGreaterThan(0);
      expect(task.primaryIdentifiers.length).toBeGreaterThan(0);
    }
  });

  it("ensures every case taskId exists and taskType matches", () => {
    const cases = loadMatrixCases();
    const tasks = loadTaskDefinitions();
    const taskById = new Map(tasks.map((task) => [task.taskId, task]));

    for (const item of cases) {
      const task = taskById.get(item.taskId);
      expect(task).toBeTruthy();
      expect(task?.taskType).toBe(item.taskType);
    }
  });
});
