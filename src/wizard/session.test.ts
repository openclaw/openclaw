// Wizard session tests cover session creation and state transitions.
import { describe, expect, test } from "vitest";
import { WizardSession } from "./session.js";

function noteRunner() {
  return new WizardSession(async (prompter) => {
    await prompter.note("Welcome");
    const name = await prompter.text({ message: "Name" });
    await prompter.note(`Hello ${name}`);
  });
}

describe("WizardSession", () => {
  test("steps progress in order", async () => {
    const session = noteRunner();

    const first = await session.next();
    expect(first.done).toBe(false);
    expect(first.step?.type).toBe("note");

    const secondPeek = await session.next();
    expect(secondPeek.step?.id).toBe(first.step?.id);

    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);

    const second = await session.next();
    expect(second.done).toBe(false);
    expect(second.step?.type).toBe("text");

    if (!second.step) {
      throw new Error("expected second step");
    }
    await session.answer(second.step.id, "Peter");

    const third = await session.next();
    expect(third.step?.type).toBe("note");

    if (!third.step) {
      throw new Error("expected third step");
    }
    await session.answer(third.step.id, null);

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("plain output is a client note with plain format", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.plain?.('{"ok":true}');
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected plain note");
    }
    expect(first.step.type).toBe("note");
    expect(first.step.message).toBe('{"ok":true}');
    expect(first.step.format).toBe("plain");
    await session.answer(first.step.id, null);
    const done = await session.next();
    expect(done.done).toBe(true);
  });

  test("invalid answers throw", async () => {
    const session = noteRunner();
    const first = await session.next();
    await expect(session.answer("bad-id", null)).rejects.toThrow(/wizard: no pending step/i);
    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);
  });

  test("cancel marks session and unblocks", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "Name" });
    });

    const step = await session.next();
    expect(step.step?.type).toBe("text");

    session.cancel();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("cancelled");
  });

  test("does not lose terminal completion when the last answer finishes the runner immediately", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "Token" });
    });

    const first = await session.next();
    expect(first.step?.type).toBe("text");
    if (!first.step) {
      throw new Error("expected first step");
    }

    await session.answer(first.step.id, "ok");
    await Promise.resolve();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("forwards sensitive flag to the emitted text step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "API key", sensitive: true });
      await prompter.text({ message: "Username" });
    });

    const sensitiveStep = (await session.next()).step;
    expect(sensitiveStep?.type).toBe("text");
    expect(sensitiveStep?.sensitive).toBe(true);
    if (!sensitiveStep) {
      throw new Error("expected sensitive step");
    }
    await session.answer(sensitiveStep.id, "fake-key-aa11");

    const plainStep = (await session.next()).step;
    expect(plainStep?.type).toBe("text");
    expect(plainStep?.sensitive).toBeUndefined();
    if (!plainStep) {
      throw new Error("expected plain step");
    }
    await session.answer(plainStep.id, "alice");
  });

  test("delivers progress steps before the next prompt and advances on re-poll", async () => {
    const session = new WizardSession(async (prompter) => {
      const spin = prompter.progress("Working");
      spin.update("Step 1");
      spin.stop("Done step");
      await prompter.text({ message: "Name" });
    });

    // progress()/update()/stop() collapse latest-wins to the final message.
    const progress = await session.next();
    expect(progress.done).toBe(false);
    expect(progress.step?.type).toBe("progress");
    expect(progress.step?.message).toBe("Done step");

    // Re-poll WITHOUT an answer advances to the interactive prompt.
    const prompt = await session.next();
    expect(prompt.step?.type).toBe("text");
    if (!prompt.step) {
      throw new Error("expected text step");
    }
    await session.answer(prompt.step.id, "Peter");

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("delivers progress emitted while a client is waiting on next()", async () => {
    let releaseWork: () => void = () => {};
    const work = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const session = new WizardSession(async (prompter) => {
      const spin = prompter.progress("Working");
      await work;
      spin.update("Halfway");
      await prompter.text({ message: "Name" });
    });

    // Initial label emitted synchronously at construction.
    const first = await session.next();
    expect(first.step?.type).toBe("progress");
    expect(first.step?.message).toBe("Working");

    // No pending step yet: this poll blocks until progress wakes it.
    const waiting = session.next();
    releaseWork();
    const woken = await waiting;
    expect(woken.step?.type).toBe("progress");
    expect(woken.step?.message).toBe("Halfway");

    const prompt = await session.next();
    expect(prompt.step?.type).toBe("text");
    if (!prompt.step) {
      throw new Error("expected text step");
    }
    await session.answer(prompt.step.id, "x");
    const done = await session.next();
    expect(done.done).toBe(true);
  });

  test("progress steps are not answerable", async () => {
    const session = new WizardSession(async (prompter) => {
      prompter.progress("Working");
      await prompter.text({ message: "Name" });
    });

    const progress = await session.next();
    if (!progress.step) {
      throw new Error("expected progress step");
    }
    await expect(session.answer(progress.step.id, null)).rejects.toThrow(
      /wizard: no pending step/i,
    );
  });

  test("cancel clears pending progress", async () => {
    const session = new WizardSession(async (prompter) => {
      prompter.progress("Working");
      await prompter.text({ message: "Name" });
    });

    session.cancel();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("cancelled");
  });

  test("concurrent next() callers never get a spurious done while running", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const session = new WizardSession(async (prompter) => {
      const spin = prompter.progress("start");
      await gate;
      spin.update("more");
      await prompter.text({ message: "Name" });
    });

    // Consume the progress emitted synchronously at construction.
    const firstStep = await session.next();
    expect(firstStep.step?.message).toBe("start");

    // Two concurrent waiters share the same internal step waiter — the race a
    // progress wake (which resolves that waiter with null) used to mishandle.
    const p1 = session.next();
    const p2 = session.next();
    releaseGate();
    const [r1, r2] = await Promise.all([p1, p2]);

    // Critical invariant: while running, no caller may surface a done result.
    expect(r1.done).toBe(false);
    expect(r2.done).toBe(false);
    expect(
      [r1.step?.type, r2.step?.type].toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["progress", "text"]);

    const textResult = [r1, r2].find((r) => r.step?.type === "text");
    if (!textResult?.step) {
      throw new Error("expected a text step");
    }
    await session.answer(textResult.step.id, "Peter");
    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });
});
