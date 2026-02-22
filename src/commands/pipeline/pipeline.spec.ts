import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const pipelineSpecSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  runDir: z.string().min(1),
  createdAt: z.string().min(1),
  phases: z.array(z.string().min(1)).min(1),
  agentId: z.string().optional(),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        phase: z.string().min(1),
        label: z.string().optional(),
        model: z.string().min(1),
        task: z.string().min(1),
        kind: z.enum(["worker", "synth", "gate"]).optional(),
        dependsOn: z.array(z.string()).optional(),
        group: z.string().optional(),
        requiresFiles: z.array(z.string()).optional(),
        producesFiles: z.array(z.string()).optional(),
        verdictFile: z.string().optional(),
      }),
    )
    .min(1),
  checkpoints: z
    .array(
      z.object({
        id: z.string(),
        afterPhase: z.string(),
        prompt: z.string(),
        interactive: z.boolean().optional(),
      }),
    )
    .optional(),
  loops: z
    .array(
      z.object({
        id: z.string(),
        verdictStepId: z.string(),
        rerunStepIds: z.array(z.string()).min(1),
        maxIterations: z.number().int().positive().optional(),
        on: z.array(z.enum(["PASS", "WARN", "FAIL", "ABORT"])).optional(),
      }),
    )
    .optional(),
});

export type PipelineSpecZ = z.infer<typeof pipelineSpecSchema>;

export function loadPipelineSpec(specPath: string): PipelineSpecZ {
  const abs = path.resolve(process.cwd(), specPath);
  const raw = fs.readFileSync(abs, "utf8");
  const json = JSON.parse(raw);
  return pipelineSpecSchema.parse(json);
}
