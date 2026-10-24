import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { DEVICE_CODE_PHISHING_WARNING, type WizardPrompter } from "./prompts.js";
import { WizardSession, wizardStepAwaitsInput, type WizardStep } from "./session.js";

async function nextStep(session: WizardSession, expected: Partial<WizardStep> = {}) {
  const step = expectDefined((await session.next()).step, "wizard step");
  expect(step).toMatchObject(expected);
  return step;
}

function nextProgress(session: WizardSession, message: string, externalUrl?: string) {
  return nextStep(session, {
    type: "progress",
    executor: "gateway",
    message,
    progressMessage: message,
    ...(externalUrl ? { externalUrl } : {}),
  });
}

function cleanupSession(session: WizardSession, release: () => void = () => {}) {
  onTestFinished(async () => {
    session.cancel();
    release();
    await session.whenSettled();
  });
}

async function expectTerminal(session: WizardSession, status = "done") {
  expect(await session.next()).toMatchObject({ done: true, status });
}

function textSession(options: Parameters<WizardPrompter["text"]>[0] = { message: "Name" }) {
  return new WizardSession(async (prompter) => {
    await prompter.text(options);
  });
}

describe("WizardSession", () => {
  test.each([true, false, "false"])(
    "only literal true confirms a wire answer (%j)",
    async (answer) => {
      let confirmed: boolean | undefined;
      const session = new WizardSession(async (prompter) => {
        confirmed = await prompter.confirm({ message: "Continue?", initialValue: false });
      });
      const step = await nextStep(session);
      await session.answer(step.id, answer);
      await session.whenSettled();
      expect(confirmed).toBe(answer === true);
    },
  );

  test.each([
    ["select", undefined, true],
    ["multiselect", undefined, true],
    ["text", undefined, true],
    ["confirm", undefined, true],
    ["action", "client", true],
    ["action", "gateway", false],
    ["note", undefined, false],
    ["progress", undefined, false],
  ] as const satisfies ReadonlyArray<
    readonly [WizardStep["type"], WizardStep["executor"], boolean]
  >)("classifies whether %s/%s awaits user input", (type, executor, expected) => {
    expect(wizardStepAwaitsInput({ id: "step", type, executor })).toBe(expected);
  });

  test("steps progress in order through a spread prompter with a note adapter", async () => {
    const session = new WizardSession(async (prompter) => {
      const adapted: WizardPrompter = { ...prompter, note: async () => {} };
      await adapted.note("Hidden install details");
      await adapted.intro("Welcome");
      const name = await adapted.text({ message: "Name" });
      await prompter.note(`Hello ${name}`, "Greeting");
      await adapted.outro("Finished");
    });
    cleanupSession(session);

    const first = await session.next();
    expect(first.done).toBe(false);
    expect(first.step?.type).toBe("note");
    expect(first.step).toMatchObject({ title: "Welcome", message: "", executor: "client" });

    const secondPeek = await session.next();
    expect(secondPeek.step?.id).toBe(first.step?.id);

    await session.answer(expectDefined(first.step, "wizard step").id, null);

    const second = await session.next();
    expect(second.done).toBe(false);
    expect(second.step?.type).toBe("text");

    await session.answer(expectDefined(second.step, "wizard step").id, "Peter");

    const third = await session.next();
    expect(third.step?.type).toBe("note");
    expect(third.step).toMatchObject({
      title: "Greeting",
      message: "Hello Peter",
      executor: "client",
    });

    await session.answer(expectDefined(third.step, "wizard step").id, null);

    const last = await nextStep(session, {
      type: "note",
      title: "Done",
      message: "Finished",
      executor: "client",
    });
    await session.answer(last.id, null);

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("plain output is a client note with plain format", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.plain?.('{"ok":true}');
    });
    const step = await nextStep(session, { type: "note", message: '{"ok":true}', format: "plain" });
    expect((await session.next()).step?.id).toBe(step.id);
    await session.answer(step.id, null);
    await expectTerminal(session);
  });

  test.each(["prepared", "activated", "utility"] as const)(
    "returns the exact %s model only on the successful terminal result",
    async (kind) => {
      const modelRef = "ollama/qwen3:0.6b";
      const session = new WizardSession(async (prompter, _signal, owner) => {
        if (kind === "prepared") {
          owner.setPreparedModelRef(modelRef);
        } else {
          owner.setModelActivation({
            modelRef,
            ...(kind === "utility" ? { modelTarget: "utility" as const } : {}),
          });
        }
        await prompter.note("Finishing setup");
      });
      const first = await session.next();
      expect(first).not.toHaveProperty("modelActivation");
      expect(first).not.toHaveProperty("preparedModelRef");
      await session.answer(expectDefined(first.step, "wizard step").id, null);
      await expect(session.next()).resolves.toEqual({
        done: true,
        status: "done",
        ...(kind === "prepared"
          ? { preparedModelRef: modelRef }
          : {
              modelActivation: {
                modelRef,
                ...(kind === "utility" ? { modelTarget: "utility" } : {}),
              },
            }),
      });
    },
  );

  test.each(["error", "cancelled"] as const)(
    "withholds model outcomes after %s, even on late completion",
    async (status) => {
      const gate = createDeferredCore();
      const session = new WizardSession(async (_prompter, _signal, owner) => {
        await gate.promise;
        owner.setPreparedModelRef("ollama/qwen3:0.6b");
        owner.setModelActivation({
          modelRef: "ollama/qwen3:0.6b",
          modelTarget: "utility",
          gatewayRestartRequired: true,
        });
        if (status === "error") {
          throw new Error("activation setup failed");
        }
      });
      if (status === "cancelled") {
        session.cancel();
      }
      gate.resolve();
      await session.whenSettled();
      const result = await session.next();
      expect(result).toMatchObject({ done: true, status });
      expect(result).not.toHaveProperty("modelActivation");
      expect(result).not.toHaveProperty("preparedModelRef");
    },
  );

  test("attaches an explicit browser destination to the next client step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.openUrl?.("https://provider.example/oauth?state=state-1");
      await prompter.text({ message: "Paste the redirect URL" });
    });
    const step = await nextStep(session, {
      externalUrl: "https://provider.example/oauth?state=state-1",
      type: "text",
    });
    await session.answer(step.id, "http://localhost/callback?code=done");
    expect((await session.next()).status).toBe("done");
  });

  test.each(["done", "cancelled"] as const)(
    "keeps a browser waiting link through progress until %s without an answer",
    async (status) => {
      const callback = createDeferredCore();
      const ready = createDeferredCore<WizardPrompter>();
      const destination = "https://provider.example/oauth?state=state-1";
      const session = new WizardSession(async (prompter) => {
        await prompter.openUrl?.(destination);
        ready.resolve(prompter);
        await callback.promise;
      });
      cleanupSession(session, callback.resolve);
      const next = session.next();
      const delivered = vi.fn();
      void next.then(delivered);
      await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
      const first = await next;
      expect(first).toMatchObject({
        done: false,
        status: "running",
        step: {
          type: "progress",
          executor: "gateway",
          externalUrl: destination,
        },
      });
      expect(wizardStepAwaitsInput(expectDefined(first.step, "browser sign-in progress"))).toBe(
        false,
      );
      const prompter = await ready.promise;
      const progress = prompter.progress("Waiting for approval");
      await nextProgress(session, "Waiting for approval", destination);
      for (const message of ["Approval received", "Finishing sign-in"]) {
        progress.update(message);
        await nextProgress(session, message, destination);
      }
      if (status === "cancelled") {
        session.cancel();
      }
      callback.resolve();
      await session.whenSettled();
      await expectTerminal(session, status);
    },
  );

  test("carries device-code presentation without parsing provider prose", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.openUrl?.("https://provider.example/device");
      await prompter.deviceCode?.({
        title: "Provider sign-in",
        code: "ABCD-1234",
        expiresInMinutes: 15,
        message: "Enter this one-time code in your browser.",
      });
    });
    const first = await session.next();
    expect(first.step).toMatchObject({
      type: "progress",
      executor: "gateway",
      title: "Provider sign-in",
      message: [
        "Enter this one-time code in your browser.",
        "https://provider.example/device",
        "Code: ABCD-1234",
        "Code expires in 15 minutes.",
        DEVICE_CODE_PHISHING_WARNING,
      ].join("\n"),
      externalUrl: "https://provider.example/device",
      deviceCode: {
        code: "ABCD-1234",
        expiresInMinutes: 15,
        message: "Enter this one-time code in your browser.",
      },
    });
    await session.whenSettled();
    await expectTerminal(session);
  });

  test.each([
    ["banana", "18789", "Enter the expected port"],
    [["token"], "token", "wizard: text answer must be a scalar value"],
  ] as const)("keeps a text step pending after answer %j", async (invalid, value, error) => {
    const resolved = vi.fn();
    const session = new WizardSession(async (prompter) => {
      resolved(
        await prompter.text({
          message: "Input",
          validate: (answer) => (answer === value ? undefined : "Enter the expected port"),
        }),
      );
    });
    const step = await nextStep(session);
    expect(step.sensitive).toBeUndefined();
    await expect(session.answer(step.id, invalid)).resolves.toBe(error);
    expect(session.getStatus()).toBe("running");
    expect((await session.next()).step?.id).toBe(step.id);
    await session.answer(step.id, value);
    expect((await session.next()).status).toBe("done");
    expect(resolved).toHaveBeenCalledWith(value);
  });

  test("returns cancellation when progress is retired before a waiting next resumes", async () => {
    const proceed = createDeferredCore();
    const session = new WizardSession(async (prompter, _signal, owner) => {
      await proceed.promise;
      prompter.progress("Starting the test");
      owner.cancel();
    });
    const pending = session.next();
    proceed.resolve();
    cleanupSession(session);
    await expect(pending).resolves.toMatchObject({ done: true, status: "cancelled" });
  });

  test.each(["before prompting", "while pending"])(
    "retires a manual prompt aborted %s without cancelling the wizard",
    async (when) => {
      const controller = new AbortController();
      const reason = new Error("browser callback completed");
      const rejected = vi.fn();
      if (when === "before prompting") {
        controller.abort(reason);
      }
      const session = new WizardSession(async (prompter) => {
        await prompter
          .text({ message: "Paste callback", signal: controller.signal })
          .catch(rejected);
        await prompter.note("Connected");
      });
      cleanupSession(session);
      let retiredStep: WizardStep | undefined;
      if (when === "while pending") {
        retiredStep = (await session.next()).step;
        expect(retiredStep?.message).toBe("Paste callback");
        controller.abort(reason);
      }
      const next = await nextStep(session, { type: "note", message: "Connected" });
      expect(rejected).toHaveBeenCalledWith(reason);
      expect(session.signal.aborted).toBe(false);
      if (retiredStep) {
        await expect(session.answer(retiredStep.id, "late-code")).rejects.toThrow(
          "no pending step",
        );
      }
      await session.answer(next.id, undefined);
      await session.whenSettled();
      expect((await session.next()).status).toBe("done");
    },
  );

  test.each(["done", "error"])(
    "retires unanswered prompts when the runner is %s",
    async (status) => {
      const finish = createDeferredCore();
      const promptFinished = createDeferredCore<unknown>();
      const session = new WizardSession(async (prompter) => {
        void prompter
          .text({ message: "Optional manual callback" })
          .then(() => promptFinished.resolve("answered"), promptFinished.resolve);
        await finish.promise;
        if (status === "error") {
          throw new Error("provider exchange failed");
        }
      });
      const step = await nextStep(session);
      finish.resolve();
      await session.whenSettled();
      await expectTerminal(session, status);
      await expect(session.answer(step.id, "late-code")).rejects.toThrow("no pending step");
      await expect(promptFinished.promise).resolves.toMatchObject({ name: "WizardCancelledError" });
    },
  );

  test("refuses cancellation after the durable commit point", async () => {
    const gate = createDeferredCore();
    const session = new WizardSession(async () => {
      await gate.promise;
    });
    session.lockCancellation();
    expect(session.cancel()).toBe(false);
    expect(session.getStatus()).toBe("running");
    expect(session.signal.aborted).toBe(false);
    expect(() => session.assertPersistentEffectCurrent()).not.toThrow();
    gate.resolve();
    expect((await session.next()).status).toBe("done");
    expect(() => session.assertPersistentEffectCurrent()).toThrow(
      "Setup session is no longer active",
    );
  });

  test("expires an abandoned interactive session", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const session = new WizardSession(
      async (prompter) => {
        await prompter.text({ message: "Name" });
      },
      { timeoutMs: 1_000 },
    );
    expect((await session.next()).step?.type).toBe("text");
    await vi.advanceTimersByTimeAsync(1_000);
    const done = await session.next();
    expect(done.status).toBe("cancelled");
    expect(session.signal.aborted).toBe(true);
  });

  test("a cancelled runner stays cancelled on late commit", async () => {
    const gate = createDeferredCore();
    let committed = false;
    const session = new WizardSession(async (_prompter, _signal, owner) => {
      await gate.promise;
      owner.lockCancellation();
      committed = true;
    });
    session.cancel();
    gate.resolve();
    await session.whenSettled();
    expect((await session.next()).status).toBe("cancelled");
    expect(committed).toBe(false);
  });

  test("does not lose terminal completion when the last answer finishes the runner immediately", async () => {
    const session = textSession({ message: "Token" });
    const step = await nextStep(session, { type: "text" });
    await session.answer(step.id, "ok");
    await Promise.resolve();
    await expectTerminal(session);
  });

  test("forwards sensitive flag to the emitted text step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "API key", sensitive: true });
      await prompter.text({ message: "Username" });
    });
    const sensitiveStep = await nextStep(session, { type: "text", sensitive: true });
    await session.answer(sensitiveStep.id, "fake-key-aa11");
    const plainStep = await nextStep(session, { type: "text" });
    expect(plainStep?.sensitive).toBeUndefined();
    await session.answer(plainStep.id, "alice");
  });

  test("bridges confirm, progress updates, and notes in order", async () => {
    const initialUpdateQueued = createDeferredCore();
    const halfway = createDeferredCore();
    const done = createDeferredCore();
    const session = new WizardSession(async (prompter) => {
      await prompter.confirm({ message: "Download model?", initialValue: false });
      const progress = prompter.progress("Starting download");
      progress.update("Downloading model... 10%");
      initialUpdateQueued.resolve();
      await halfway.promise;
      progress.update("Downloading model... 50%");
      await done.promise;
      progress.stop("Model downloaded");
      await prompter.note("Ready to use", "Prepared");
    });
    const confirm = await nextStep(session, {
      type: "confirm",
      message: "Download model?",
      initialValue: false,
    });
    await session.answer(confirm.id, true);
    await initialUpdateQueued.promise;
    await nextProgress(session, "Starting download");
    await nextProgress(session, "Downloading model... 10%");
    const halfwayStep = nextProgress(session, "Downloading model... 50%");
    halfway.resolve();
    await halfwayStep;
    const doneStep = nextProgress(session, "Model downloaded");
    done.resolve();
    const completedProgress = await doneStep;
    await expect(session.answer(completedProgress.id, undefined)).resolves.toBeUndefined();
    expect(await session.next()).toMatchObject({
      step: { type: "note", title: "Prepared", message: "Ready to use" },
    });
  });
});
