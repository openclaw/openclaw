import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { createComposerTasks } from "./composer-tasks.runtime.ts";

function setup(value: string) {
  return createRoot((dispose) => {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    document.body.append(textarea);
    const tasks = createComposerTasks({
      taskPresenters: 1,
      composerComposing: false,
      composerTextarea: textarea,
      sendDraft: null,
    });
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
  it("keeps a proposal and its Undo receipt while the editor is locked", async () => {
    const { tasks, textarea, dispose } = setup("my draft");
    try {
      const outcome = tasks.offer("rewritten", { title: "Rewrite" }, new AbortController().signal);
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
      flush();
      textarea.readOnly = true;
      tasks.undo(textarea);
      flush();
      expect(tasks.accepted?.title).toBe("Rewrite");
    } finally {
      dispose();
    }
  });
});
