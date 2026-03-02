/**
 * Plan Approval Flow
 *
 * Stores plans submitted by worker agents and provides gate/approve/reject
 * primitives for lead agents.  Plans are stored as files in the workspace
 * so they survive process restarts.
 *
 * Flow:
 *   1. Worker calls submitPlan(workspaceDir, plan)      → status "pending"
 *   2. Lead   calls approvePlan(workspaceDir, planId)    → status "approved"
 *          or rejectPlan(workspaceDir, planId, reason)   → status "rejected"
 *   3. Worker checks getPlan(workspaceDir, planId).status
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type PlanStatus = "pending" | "approved" | "rejected";

export type Plan = {
  id: string;
  agentId: string;
  taskId: string;
  title: string;
  steps: string[];
  toolsRequested?: string[];
  status: PlanStatus;
  submittedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  rejectReason?: string;
};

const PLANS_DIR = ".openclaw/plans";

async function ensurePlansDir(workspaceDir: string): Promise<string> {
  const dir = path.join(workspaceDir, PLANS_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function planFilePath(dir: string, planId: string): string {
  return path.join(dir, `${planId}.json`);
}

export async function submitPlan(
  workspaceDir: string,
  plan: Omit<Plan, "id" | "status" | "submittedAt">,
): Promise<Plan> {
  const dir = await ensurePlansDir(workspaceDir);
  const id = `plan_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const full: Plan = {
    ...plan,
    id,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };
  await fs.writeFile(planFilePath(dir, id), JSON.stringify(full, null, 2));
  return full;
}

export async function getPlan(workspaceDir: string, planId: string): Promise<Plan | null> {
  const dir = await ensurePlansDir(workspaceDir);
  try {
    const content = await fs.readFile(planFilePath(dir, planId), "utf-8");
    return JSON.parse(content) as Plan;
  } catch {
    return null;
  }
}

export async function approvePlan(
  workspaceDir: string,
  planId: string,
  decidedBy?: string,
): Promise<Plan | null> {
  const plan = await getPlan(workspaceDir, planId);
  if (!plan || plan.status !== "pending") {
    return null;
  }
  plan.status = "approved";
  plan.decidedAt = new Date().toISOString();
  plan.decidedBy = decidedBy;
  const dir = await ensurePlansDir(workspaceDir);
  await fs.writeFile(planFilePath(dir, planId), JSON.stringify(plan, null, 2));
  return plan;
}

export async function rejectPlan(
  workspaceDir: string,
  planId: string,
  reason?: string,
  decidedBy?: string,
): Promise<Plan | null> {
  const plan = await getPlan(workspaceDir, planId);
  if (!plan || plan.status !== "pending") {
    return null;
  }
  plan.status = "rejected";
  plan.rejectReason = reason;
  plan.decidedAt = new Date().toISOString();
  plan.decidedBy = decidedBy;
  const dir = await ensurePlansDir(workspaceDir);
  await fs.writeFile(planFilePath(dir, planId), JSON.stringify(plan, null, 2));
  return plan;
}

export async function listPendingPlans(workspaceDir: string): Promise<Plan[]> {
  const dir = await ensurePlansDir(workspaceDir);
  const files = await fs.readdir(dir).catch(() => []);
  const plans: Plan[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const content = await fs.readFile(path.join(dir, file), "utf-8");
      const plan = JSON.parse(content) as Plan;
      if (plan.status === "pending") {
        plans.push(plan);
      }
    } catch {
      // skip malformed
    }
  }
  return plans;
}
