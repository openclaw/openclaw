import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createUiE2eSetupObserver } from "./ui-e2e-phase.js";

it("retains pending setup privately and releases its exit listener when the owner retires", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-e2e-setup-proof-"));
  vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", root);
  vi.stubEnv("OPENCLAW_VITEST_MAX_WORKERS", "4");
  vi.stubEnv("OPENCLAW_VITEST_WORKER_CACHE", "");
  const listeners = process.listeners("exit");
  const observer = createUiE2eSetupObserver("test/helpers/ui-e2e-setup-stage.test.ts");
  const gate = Promise.withResolvers<string>();
  const waiting = observer.run("ui-assets", () => gate.promise, { prebuiltAssets: false });
  onTestFinished(async () => {
    gate.resolve("synthetic-result-not-recorded");
    await waiting;
    observer.report();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const onExit = process.listeners("exit").find((listener) => !listeners.includes(listener));
  expect(process.listenerCount("exit")).toBe(listeners.length + 1);
  const file = path.join(root, readdirSync(root)[0]!, "failure.public.json");
  const read = (): unknown => JSON.parse(readFileSync(file, "utf8"));
  expect(read()).toMatchObject({
    kind: "ui-e2e-setup",
    source: "test/helpers/ui-e2e-setup-stage.test.ts",
    reason: "transition",
    maxWorkers: 4,
    workerCache: false,
    events: [{ stage: "ui-assets", edge: "enter", prebuiltAssets: false }],
  });
  expect(onExit).toBeTypeOf("function");
  onExit?.(0);
  expect(read()).toMatchObject({ reason: "process-exit", events: [{ edge: "enter" }] });
  gate.resolve("synthetic-result-not-recorded");
  await expect(waiting).resolves.toBe("synthetic-result-not-recorded");
  const failure = new Error("synthetic-error-not-recorded");
  await expect(
    observer.run("http-import", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  observer.report();
  expect(process.listeners("exit")).toEqual(listeners);
  expect(read()).toMatchObject({
    reason: "teardown",
    events: [
      { stage: "ui-assets", edge: "enter" },
      { stage: "ui-assets", edge: "exit" },
      { stage: "http-import", edge: "enter" },
      { stage: "http-import", edge: "exit" },
    ],
  });
  const bytes = readFileSync(file, "utf8");
  expect(bytes).not.toContain("synthetic-result-not-recorded");
  expect(bytes).not.toContain("synthetic-error-not-recorded");
});
