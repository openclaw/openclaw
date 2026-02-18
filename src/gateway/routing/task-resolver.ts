import { TaskType } from "./types.js";

export function resolveTaskType(_text: string): TaskType {
  return TaskType.FALLBACK;
}
