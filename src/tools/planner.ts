import { evaluateToolAvailability } from "./availability.js";
import { ToolPlanContractError } from "./diagnostics.js";
import type {
  BuildToolPlanOptions,
  HiddenToolPlanEntry,
  ToolExecutorRef,
  ToolDescriptor,
  ToolPlan,
  ToolPlanEntry,
} from "./types.js";

type PlanningDescriptor = {
  descriptor: ToolDescriptor;
  executor: ToolExecutorRef | undefined;
  index: number;
  name: string;
  sortKey: string;
};

function invalidDescriptor(index: number, message: string): never {
  const toolName = `tool[${index}]`;
  throw new ToolPlanContractError({
    code: "invalid-descriptor",
    toolName,
    message: `${message}: ${toolName}`,
  });
}

function readDescriptorField(
  descriptor: ToolDescriptor,
  field: keyof ToolDescriptor,
  index: number,
): unknown {
  try {
    return descriptor[field];
  } catch {
    return invalidDescriptor(index, `Tool descriptor ${field} is unreadable`);
  }
}

function prepareDescriptor(descriptor: ToolDescriptor, index: number): PlanningDescriptor {
  const name = readDescriptorField(descriptor, "name", index);
  if (typeof name !== "string") {
    invalidDescriptor(index, "Tool descriptor name must be a string");
  }

  const sortKey = readDescriptorField(descriptor, "sortKey", index);
  if (sortKey !== undefined && typeof sortKey !== "string") {
    invalidDescriptor(index, "Tool descriptor sortKey must be a string when present");
  }

  return {
    descriptor,
    executor: readDescriptorField(descriptor, "executor", index) as ToolExecutorRef | undefined,
    index,
    name,
    sortKey: sortKey ?? name,
  };
}

function compareDescriptors(left: PlanningDescriptor, right: PlanningDescriptor): number {
  return (
    left.sortKey.localeCompare(right.sortKey) ||
    left.name.localeCompare(right.name) ||
    left.index - right.index
  );
}

function assertUniqueNames(descriptors: readonly PlanningDescriptor[]): void {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new ToolPlanContractError({
        code: "duplicate-tool-name",
        toolName: descriptor.name,
        message: `Duplicate tool descriptor name: ${descriptor.name}`,
      });
    }
    seen.add(descriptor.name);
  }
}

export function buildToolPlan(options: BuildToolPlanOptions): ToolPlan {
  const descriptors = options.descriptors.map(prepareDescriptor).toSorted(compareDescriptors);
  assertUniqueNames(descriptors);

  const visible: ToolPlanEntry[] = [];
  const hidden: HiddenToolPlanEntry[] = [];

  for (const planned of descriptors) {
    const descriptor = planned.descriptor;
    const diagnostics = [
      ...evaluateToolAvailability({ descriptor, context: options.availability }),
    ];
    if (diagnostics.length > 0) {
      hidden.push({ descriptor, diagnostics });
      continue;
    }
    if (!planned.executor) {
      throw new ToolPlanContractError({
        code: "missing-executor",
        toolName: planned.name,
        message: `Visible tool descriptor has no executor ref: ${planned.name}`,
      });
    }
    visible.push({ descriptor, executor: planned.executor });
  }

  return { visible, hidden };
}
