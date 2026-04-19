import { MinionQueue } from "./queue.js";
import type { MinionJob, MinionJobInput } from "./types.js";

export interface FanOutChild {
  name: string;
  data?: Record<string, unknown>;
  opts?: Partial<Omit<MinionJobInput, "parentJobId">>;
}

export interface FanOutResult {
  parent: MinionJob;
  children: MinionJob[];
}

export function submitFanOut(
  queue: MinionQueue,
  parentName: string,
  children: FanOutChild[],
  parentOpts?: Partial<MinionJobInput>,
): FanOutResult {
  if (children.length === 0) {
    throw new Error("Fan-out requires at least one child");
  }

  const parent = queue.add(parentName, {}, {
    ...parentOpts,
    maxChildren: parentOpts?.maxChildren ?? children.length,
  });

  const created: MinionJob[] = [];
  for (const child of children) {
    const job = queue.add(child.name, child.data, {
      ...child.opts,
      parentJobId: parent.id,
    });
    created.push(job);
  }

  const updatedParent = queue.getJob(parent.id)!;
  return { parent: updatedParent, children: created };
}
