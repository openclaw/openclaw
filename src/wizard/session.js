import { randomUUID } from "node:crypto";
import { WizardCancelledError } from "./prompts.js";
function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
class WizardSessionPrompter {
    session;
    constructor(session) {
        this.session = session;
    }
    async intro(title) {
        await this.prompt({
            type: "note",
            title,
            message: "",
            executor: "client",
        });
    }
    async outro(message) {
        await this.prompt({
            type: "note",
            title: "Done",
            message,
            executor: "client",
        });
    }
    async note(message, title) {
        await this.prompt({ type: "note", title, message, executor: "client" });
    }
    async select(params) {
        const res = await this.prompt({
            type: "select",
            message: params.message,
            options: params.options.map((opt) => ({
                value: opt.value,
                label: opt.label,
                hint: opt.hint,
            })),
            initialValue: params.initialValue,
            executor: "client",
        });
        return res;
    }
    async multiselect(params) {
        const res = await this.prompt({
            type: "multiselect",
            message: params.message,
            options: params.options.map((opt) => ({
                value: opt.value,
                label: opt.label,
                hint: opt.hint,
            })),
            initialValue: params.initialValues,
            executor: "client",
        });
        return (Array.isArray(res) ? res : []);
    }
    async text(params) {
        const res = await this.prompt({
            type: "text",
            message: params.message,
            initialValue: params.initialValue,
            placeholder: params.placeholder,
            executor: "client",
        });
        const value = res === null || res === undefined
            ? ""
            : typeof res === "string"
                ? res
                : typeof res === "number" || typeof res === "boolean" || typeof res === "bigint"
                    ? String(res)
                    : "";
        const error = params.validate?.(value);
        if (error) {
            throw new Error(error);
        }
        return value;
    }
    async confirm(params) {
        const res = await this.prompt({
            type: "confirm",
            message: params.message,
            initialValue: params.initialValue,
            executor: "client",
        });
        return Boolean(res);
    }
    progress(_label) {
        return {
            update: (_message) => { },
            stop: (_message) => { },
        };
    }
    async prompt(step) {
        return await this.session.awaitAnswer({
            ...step,
            id: randomUUID(),
        });
    }
}
export class WizardSession {
    runner;
    currentStep = null;
    stepDeferred = null;
    answerDeferred = new Map();
    status = "running";
    error;
    constructor(runner) {
        this.runner = runner;
        const prompter = new WizardSessionPrompter(this);
        void this.run(prompter);
    }
    async next() {
        if (this.currentStep) {
            return { done: false, step: this.currentStep, status: this.status };
        }
        if (this.status !== "running") {
            return { done: true, status: this.status, error: this.error };
        }
        if (!this.stepDeferred) {
            this.stepDeferred = createDeferred();
        }
        const step = await this.stepDeferred.promise;
        if (step) {
            return { done: false, step, status: this.status };
        }
        return { done: true, status: this.status, error: this.error };
    }
    async answer(stepId, value) {
        const deferred = this.answerDeferred.get(stepId);
        if (!deferred) {
            throw new Error("wizard: no pending step");
        }
        this.answerDeferred.delete(stepId);
        this.currentStep = null;
        deferred.resolve(value);
    }
    cancel() {
        if (this.status !== "running") {
            return;
        }
        this.status = "cancelled";
        this.error = "cancelled";
        this.currentStep = null;
        for (const [, deferred] of this.answerDeferred) {
            deferred.reject(new WizardCancelledError());
        }
        this.answerDeferred.clear();
        this.resolveStep(null);
    }
    pushStep(step) {
        this.currentStep = step;
        this.resolveStep(step);
    }
    async run(prompter) {
        try {
            await this.runner(prompter);
            this.status = "done";
        }
        catch (err) {
            if (err instanceof WizardCancelledError) {
                this.status = "cancelled";
                this.error = err.message;
            }
            else {
                this.status = "error";
                this.error = String(err);
            }
        }
        finally {
            this.resolveStep(null);
        }
    }
    async awaitAnswer(step) {
        if (this.status !== "running") {
            throw new Error("wizard: session not running");
        }
        this.pushStep(step);
        const deferred = createDeferred();
        this.answerDeferred.set(step.id, deferred);
        return await deferred.promise;
    }
    resolveStep(step) {
        if (!this.stepDeferred) {
            return;
        }
        const deferred = this.stepDeferred;
        this.stepDeferred = null;
        deferred.resolve(step);
    }
    getStatus() {
        return this.status;
    }
    getError() {
        return this.error;
    }
}
