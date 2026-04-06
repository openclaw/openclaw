import {
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  VIDEO_GENERATION_TASK_KIND,
} from "../agents/video-generation-task-status.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { getTaskById } from "../tasks/task-registry.js";

export type VideoStatusOpts = {
  taskId: string;
  json?: boolean;
};

export async function videoStatusCommand(
  opts: VideoStatusOpts,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const task = getTaskById(opts.taskId);

  if (!task) {
    runtime.error(`Task not found: ${opts.taskId}`);
    runtime.exit(1);
    return;
  }

  if (task.taskKind !== VIDEO_GENERATION_TASK_KIND) {
    runtime.error(
      `Task ${opts.taskId} is not a video generation task (taskKind: ${task.taskKind})`,
    );
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    runtime.writeJson(buildVideoGenerationTaskStatusDetails(task));
    return;
  }

  runtime.log(buildVideoGenerationTaskStatusText(task));
}
