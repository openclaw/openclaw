import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { createComposerTasks } from "./chat-composer-task.ts";

function setup(value: string) {
  return createRoot((dispose) => {
    const tasks = createComposerTasks(() => true);
    const textarea = document.createElement("textarea");
    textarea.value = value;
    document.body.append(textarea);
    return {
      tasks,
      textarea,
      dispose: () => {
        textarea.remove();
        dispose();
      },
    };
  });
}

describe("composer tasks", () => {
  it("keeps a proposal pending while the editor is locked", async () => {
    const { tasks, textarea, dispose } = setup("my draft");
    try {
      const outcome = tasks.offer("rewritten", "Rewrite", new AbortController().signal);
      flush();
      textarea.readOnly = true;
      expect(tasks.accept(textarea)).toBe(false);
      flush();
      expect(tasks.card?.kind).toBe("proposal");
      expect(textarea.value).toBe("my draft");
      textarea.readOnly = false;
      expect(tasks.accept(textarea)).toBe(true);
      await expect(outcome).resolves.toBe("accepted");
      expect(textarea.value).toBe("rewritten");
    } finally {
      dispose();
    }
  });
});
